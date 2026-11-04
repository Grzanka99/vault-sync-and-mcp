# mcp-vault

Sync your Obsidian vault with your own server. The server keeps plain `.md` files, so agents on that machine can work with your notes, directly or over MCP. Their edits show up in Obsidian within a second.

- **Plugin**: desktop and mobile. Log in with username + password.
- **Server**: one Node process. Plain files on disk, SQLite for the index (hashes, history, users, search).
- **Conflicts**: edits to different lines merge automatically. Overlapping edits keep both versions (`Note (conflict Phone 2026-10-18 15-30-12).md`). Nothing is lost.
- **MCP**: built in, over HTTP (`/mcp`) or stdio (`mcp-vault mcp`).

## Run the server

Needs Node 24+ and pnpm.

```sh
pnpm install
pnpm server user add me                 # asks for a password
pnpm server serve --vault ~/notes --host 0.0.0.0
```

Or with Podman: `cp .env.example .env`, set the user and password there, then `podman compose up -d`.

Phones need **HTTPS** (iOS blocks plain http/ws). Put the server behind Caddy, nginx or `tailscale serve`, and set `MCP_VAULT_TRUST_PROXY=true`.

All options: `pnpm server help`.

## Install the plugin

```sh
pnpm install:plugin /path/to/your/vault
```

Then in Obsidian: Settings → Community plugins → enable **MCP Vault Sync**. In its settings, enter the server URL and log in.

For your phone, copy `packages/plugin/dist/main.js` and `manifest.json` into `<vault>/.obsidian/plugins/mcp-vault-sync/` (or let the desktop sync it: turn on "Sync settings folder").

Settings folder sync is optional. The window layout and this plugin's login never sync.

### Network use and accounts

- **Network use:** the plugin talks only to the server URL you enter. It sends and receives your vault's files so they stay in sync, and keeps a WebSocket open to hear about changes right away. Use an `https://` URL so this traffic is encrypted; with `http://` it is not, and iOS refuses it. Nothing goes anywhere else.
- **Account required:** you need an account on your own mcp-vault server (`pnpm server user add`). There is no hosted service and nothing to pay for.
- **No telemetry:** the plugin collects no usage data.
- **Files:** the plugin reads and writes only inside the vault. With "Sync settings folder" on, that includes the vault's settings folder.

## Connect an agent

**Same machine (default):** `mcp-vault serve` writes `data/local-agent.token`. The stdio command finds it on its own:

```json
{
  "mcpServers": {
    "vault": {
      "command": "node",
      "args": ["/path/to/mcp-vault/packages/server/src/main.ts", "mcp", "--data", "/path/to/data"]
    }
  }
}
```

In Podman: `podman exec -i mcp-vault node packages/server/src/main.ts mcp`.

**Other machine:** create a token, then use HTTP MCP:

```sh
pnpm server token create me claude
claude mcp add --transport http vault https://notes.example.com/mcp --header "Authorization: Bearer mv_…"
```

Tools: `list_files`, `read_note`, `search_notes`, `write_note`, `append_to_note`, `edit_note`, `move_note`, `delete_note`, `recent_changes`.

Agents can also just edit files in the vault folder. The server watches it.

## Accounts

```sh
pnpm server user add | passwd | list | remove
pnpm server token list            # every logged-in device and API token
pnpm server token revoke <id>     # log a device out
```

## How sync works

Every change gets a number (`seq`). A client asks "what changed since N?", downloads that, and uploads its own changes with the version it started from. If the server's copy moved on in between, it does a 3-way merge. If the merge fails, it keeps both versions. A WebSocket pokes clients when something changes. Polling is the fallback.

## Develop

```sh
vp check      # format, lint, types
vp test
pnpm build:plugin
```

Code rules are in [AGENTS.md](AGENTS.md).
