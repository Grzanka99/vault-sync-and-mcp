// `mcp-vault mcp`: stdio MCP server for agents on the same machine.
// It only forwards messages to the running server's /mcp endpoint, so all writes still go through
// one process and Obsidian clients get notified right away.

// MCP transports are not EventTargets; they only offer on* callbacks.
/* oxlint-disable unicorn/prefer-add-event-listener */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "@mcp-vault/core";

/** Answer a request ourselves when the server can't, so the agent gets an error instead of hanging. */
function errorReply(message: JSONRPCMessage, text: string): JSONRPCMessage | null {
  if (!("id" in message) || !("method" in message)) {
    return null;
  }
  return { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } };
}

export async function runStdioBridge(serverUrl: string, token: string): Promise<void> {
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL("/mcp", serverUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });

  local.onmessage = (message) => {
    remote.send(message).catch((error) => {
      const text = `mcp-vault server at ${serverUrl} is not reachable: ${errorMessage(error)}`;
      console.error(text);
      const reply = errorReply(message, text);
      if (reply) {
        void local.send(reply);
      }
    });
  };
  remote.onmessage = (message) => {
    void local.send(message);
  };
  remote.onerror = (error) => {
    console.error(`mcp-vault bridge: ${error.message}`);
  };
  // The agent closed our stdin: it's done with us.
  const shutdown = () => {
    void remote.close();
    process.exit(0);
  };
  local.onclose = shutdown;
  process.stdin.on("end", shutdown);

  await remote.start();
  await local.start();
}
