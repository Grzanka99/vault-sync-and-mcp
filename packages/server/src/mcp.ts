// MCP tools over the vault. Writes go through the same Vault as sync uploads, so
// Obsidian clients get notified right away.

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { encodeText, errorMessage, normalizePath } from "@mcp-vault/core";
import { VaultError, type Actor, type Vault } from "./vault.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function reply(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Turn thrown errors into tool errors the agent can read, instead of protocol failures. */
async function guarded(run: () => Promise<string>): Promise<ToolResult> {
  try {
    return reply(await run());
  } catch (error) {
    return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

async function readText(vault: Vault, path: string): Promise<{ text: string; hash: string }> {
  const { data, entry } = await vault.read(normalizePath(path));
  try {
    return { text: strictUtf8.decode(data), hash: entry.hash };
  } catch {
    throw new VaultError(415, `${path} is not a text file`);
  }
}

function countOccurrences(text: string, part: string): number {
  let count = 0;
  let from = text.indexOf(part);
  while (from !== -1) {
    count++;
    from = text.indexOf(part, from + part.length);
  }
  return count;
}

export function createMcpServer(vault: Vault, actor: Actor): McpServer {
  const server = new McpServer({ name: "mcp-vault", version: "0.1.0" });
  const path = z.string().describe('Vault-relative path, e.g. "Projects/Plan.md"');

  server.registerTool(
    "list_files",
    {
      description: "List files in the vault (or a folder). One per line: path, size in bytes, modified time.",
      inputSchema: { folder: z.string().optional(), limit: z.number().int().positive().optional() },
    },
    ({ folder, limit }) =>
      guarded(async () => {
        const files = await vault.list(normalizePath(folder ?? ""));
        const shown = files.slice(0, limit ?? 1000);
        const lines = shown.map((f) => `${f.path}\t${f.size}\t${new Date(f.mtime).toISOString()}`);
        if (files.length > shown.length) {
          lines.push(`… ${files.length - shown.length} more`);
        }
        return lines.join("\n") || "(empty)";
      }),
  );

  server.registerTool(
    "read_note",
    {
      description:
        "Read a note. The first line is `hash: <hash>`; pass it as expected_hash to write_note to avoid overwriting newer edits.",
      inputSchema: { path },
    },
    ({ path: notePath }) =>
      guarded(async () => {
        const { text, hash } = await readText(vault, notePath);
        return `hash: ${hash}\n\n${text}`;
      }),
  );

  server.registerTool(
    "search_notes",
    {
      description:
        'Full-text search over markdown notes. Words are ANDed; end a word with * for prefix ("proj*").',
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
    },
    ({ query, limit }) =>
      guarded(async () => {
        const hits = vault.search(query, limit ?? 20);
        if (hits.length === 0) {
          return "no matches";
        }
        return hits.map((hit) => `${hit.path}\n  ${hit.snippet}`).join("\n");
      }),
  );

  server.registerTool(
    "write_note",
    {
      description:
        "Create or replace a note. Give expected_hash (from read_note) when replacing, so concurrent edits aren't lost.",
      inputSchema: { path, content: z.string(), expected_hash: z.string().optional() },
    },
    ({ path: notePath, content, expected_hash }) =>
      guarded(async () => {
        const entry = await vault.writeNote(
          normalizePath(notePath),
          encodeText(content),
          expected_hash,
          actor,
        );
        return `saved ${entry.path} (hash: ${entry.hash})`;
      }),
  );

  server.registerTool(
    "append_to_note",
    {
      description: "Append text to the end of a note (creates it if missing).",
      inputSchema: { path, content: z.string() },
    },
    ({ path: notePath, content }) =>
      guarded(async () => {
        const target = normalizePath(notePath);
        let existing = "";
        let expected: string | null = null;
        try {
          const current = await readText(vault, target);
          existing = current.text;
          expected = current.hash;
        } catch (error) {
          if (!(error instanceof VaultError) || error.status !== 404) {
            throw error;
          }
        }
        let separator = "";
        if (existing !== "" && !existing.endsWith("\n")) {
          separator = "\n";
        }
        const entry = await vault.writeNote(
          target,
          encodeText(existing + separator + content),
          expected,
          actor,
        );
        return `appended to ${entry.path} (hash: ${entry.hash})`;
      }),
  );

  server.registerTool(
    "edit_note",
    {
      description:
        "Replace one exact occurrence of old_text with new_text. Fails if old_text is missing or not unique.",
      inputSchema: { path, old_text: z.string().min(1), new_text: z.string() },
    },
    ({ path: notePath, old_text, new_text }) =>
      guarded(async () => {
        const target = normalizePath(notePath);
        const { text, hash } = await readText(vault, target);
        const count = countOccurrences(text, old_text);
        if (count !== 1) {
          throw new VaultError(400, `old_text found ${count} times in ${target}; it must match exactly once`);
        }
        const updated = text.replace(old_text, () => new_text);
        const entry = await vault.writeNote(target, encodeText(updated), hash, actor);
        return `edited ${entry.path} (hash: ${entry.hash})`;
      }),
  );

  server.registerTool(
    "move_note",
    { description: "Move or rename a file.", inputSchema: { from: path, to: path } },
    ({ from, to }) =>
      guarded(async () => {
        const entry = await vault.moveNote(normalizePath(from), normalizePath(to), actor);
        return `moved to ${entry.path}`;
      }),
  );

  server.registerTool(
    "delete_note",
    { description: "Delete a file.", inputSchema: { path } },
    ({ path: notePath }) =>
      guarded(async () => {
        await vault.deleteNote(normalizePath(notePath), actor);
        return `deleted ${notePath}`;
      }),
  );

  server.registerTool(
    "recent_changes",
    {
      description: "Most recently changed files, newest first, with who changed them.",
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    ({ limit }) =>
      guarded(async () => {
        const lines = vault.recent(limit ?? 20).map((entry) => {
          let what = "changed";
          if (entry.deleted) {
            what = "deleted";
          }
          return `${new Date(entry.mtime).toISOString()}  ${what}  ${entry.path}  by ${entry.device ?? "?"}`;
        });
        return lines.join("\n") || "no changes yet";
      }),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. */
export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  vault: Vault,
  actor: Actor,
): Promise<void> {
  const server = createMcpServer(vault, actor);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
