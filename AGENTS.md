# AGENTS.md

Obsidian notes are just .md files. Goal: same notes everywhere — laptop, phone, server.

Plugin lives in Obsidian. Log in, point it at the server, done. Desktop and mobile.

Server runs alone on some box. Keeps plain .md files on disk, no special format. Agents read and write those files directly, or talk to the server over MCP. Agent edits a note → shows up in Obsidian. You edit → agent sees it.

Sync is near instant. Both sides changed one note → merge. Merge fails → keep both, write a conflict copy. Never lose data.

SQLite is only a helper: hashes, versions, users, search. Files on disk are the truth.

## Layout

- `packages/core` – sync logic shared by plugin and server
- `packages/server` – server + MCP
- `packages/plugin` – Obsidian plugin

## Rules

- Code must be easy for a human to follow
- No regex
- No ternaries
- Always `{ }` on if/for/while
- Max 5000 tokens per file (pre-commit checks). Too big → split.
- No secrets in git: tokens, passwords, keys go in env vars or `.env` (pre-commit checks)
- pnpm + `vp`: `vp check` (lint, fmt, types), `vp test`
