#!/usr/bin/env node
// Entry point: `mcp-vault serve` runs the sync + MCP server; other commands manage users and tokens.

import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { errorMessage } from "@mcp-vault/core";
import { adminUsage, runAdmin } from "./admin.ts";
import { hashPassword, loadLocalAgentToken } from "./auth.ts";
import { loadConfig, parseArgs, type Config } from "./config.ts";
import { createHttpServer } from "./http.ts";
import { runStdioBridge } from "./stdio-bridge.ts";
import { Store } from "./store.ts";
import { Vault } from "./vault.ts";

const HELP = `mcp-vault – sync server for Obsidian vaults, with MCP

  serve                                   run the server
  mcp [--url <url>] [--token <token>]     stdio MCP for agents on this machine (needs serve running)
${adminUsage()}
Options (flag / env):
  --vault <dir>    MCP_VAULT_DIR      folder with the notes (default ./vault)
  --data <dir>     MCP_VAULT_DATA     index database folder (default ./data)
  --host <host>    HOST               default 127.0.0.1 (0.0.0.0 to allow other devices)
  --port <port>    PORT               default 8787
  --exclude <a,b>  MCP_VAULT_EXCLUDE  extra ignore patterns
  --trust-proxy    MCP_VAULT_TRUST_PROXY=true   behind a reverse proxy

First start: set MCP_VAULT_ADMIN_USER + MCP_VAULT_ADMIN_PASSWORD to create the first user.
`;

async function openStore(config: Config): Promise<Store> {
  await fsp.mkdir(config.dataDir, { recursive: true });
  return new Store(nodePath.join(config.dataDir, "index.db"));
}

/** Create the first user from env vars, so a fresh container is usable right away. */
async function bootstrapAdmin(store: Store): Promise<void> {
  const username = process.env.MCP_VAULT_ADMIN_USER;
  const password = process.env.MCP_VAULT_ADMIN_PASSWORD;
  if (!username || !password || store.userCount() > 0) {
    return;
  }
  store.createUser(username, await hashPassword(password));
  console.log(`created first user ${username}`);
}

async function serve(config: Config): Promise<void> {
  const store = await openStore(config);
  await bootstrapAdmin(store);
  if (store.userCount() === 0) {
    console.warn("no users yet – create one with: mcp-vault user add <username>");
  }

  const vault = new Vault({
    root: config.vaultDir,
    store,
    excludes: config.excludes,
    rescanMinutes: config.rescanMinutes,
    historyDays: config.historyDays,
  });
  await vault.start();

  const server = createHttpServer({
    vault,
    store,
    maxUploadBytes: config.maxUploadBytes,
    trustProxy: config.trustProxy,
    localToken: await loadLocalAgentToken(config.dataDir, true),
  });
  server.listen(config.port, config.host, () => {
    console.log(`mcp-vault listening on http://${config.host}:${config.port}`);
    console.log(`  vault: ${config.vaultDir}`);
    console.log(`  MCP:   http://${config.host}:${config.port}/mcp`);
  });

  const shutdown = () => {
    console.log("shutting down");
    vault.stop();
    server.close();
    server.closeAllConnections();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Connect stdio to the local server. Logs go to stderr: stdout belongs to the MCP protocol. */
async function bridge(config: Config, flags: Map<string, string>): Promise<void> {
  const url = flags.get("url") ?? process.env.MCP_VAULT_URL ?? `http://127.0.0.1:${config.port}`;
  const token =
    flags.get("token") ?? process.env.MCP_VAULT_TOKEN ?? (await loadLocalAgentToken(config.dataDir, false));
  if (!token) {
    throw new Error(
      `no token: start \`mcp-vault serve\` once (it writes ${config.dataDir}/local-agent.token) or pass --token`,
    );
  }
  await runStdioBridge(url, token);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  const config = loadConfig(args.flags);

  if (command === "serve") {
    await serve(config);
    return;
  }
  if (command === "mcp") {
    await bridge(config, args.flags);
    return;
  }
  if (command === "user" || command === "token") {
    const store = await openStore(config);
    try {
      await runAdmin(store, args);
    } finally {
      store.close();
    }
    return;
  }
  console.log(HELP);
  if (command && command !== "help") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`error: ${errorMessage(error)}`);
  process.exit(1);
});
