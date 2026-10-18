// Copy the built plugin into a vault: node scripts/install-plugin.ts /path/to/vault

import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

const vault = process.argv[2];
if (!vault) {
  console.error("usage: pnpm install:plugin /path/to/vault");
  process.exit(1);
}

const source = nodePath.join(import.meta.dirname, "..", "packages", "plugin", "dist");
const target = nodePath.join(vault, ".obsidian", "plugins", "mcp-vault-sync");
await fsp.mkdir(target, { recursive: true });
for (const file of ["main.js", "manifest.json"]) {
  await fsp.copyFile(nodePath.join(source, file), nodePath.join(target, file));
}
console.log(`installed to ${target} – enable "MCP Vault Sync" in Obsidian → Settings → Community plugins`);
