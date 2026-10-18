// `mcp-vault user …` and `mcp-vault token …` commands. Safe to run while the server is running.

import * as readline from "node:readline/promises";
import { hashPassword, issueToken } from "./auth.ts";
import type { ParsedArgs } from "./config.ts";
import type { Store } from "./store.ts";

const USAGE = `
  user add <username> [--password <pw>]   create a user (prompts for the password)
  user passwd <username> [--password <pw>]
  user list
  user remove <username>
  token create <username> <name>           API token for MCP clients / agents
  token list                               all logins and API tokens
  token revoke <id>
`;

export function adminUsage(): string {
  return USAGE;
}

/** Ask for a password without echoing it. Reads one line from stdin when not a terminal. */
async function askPassword(prompt: string): Promise<string> {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Node has no public "hide input" option; overriding this internal hook is the usual workaround.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const silent = input as unknown as { _writeToOutput: (text: string) => void };
  let muted = false;
  // oxlint-disable-next-line no-underscore-dangle
  silent._writeToOutput = (text) => {
    if (!muted) {
      process.stdout.write(text);
    }
  };
  const answer = input.question(prompt);
  muted = true;
  const password = await answer;
  input.close();
  process.stdout.write("\n");
  return password;
}

async function passwordFrom(args: ParsedArgs): Promise<string> {
  const given = args.flags.get("password") ?? process.env.MCP_VAULT_PASSWORD;
  if (given) {
    return given;
  }
  const first = await askPassword("Password: ");
  const second = await askPassword("Repeat password: ");
  if (first !== second) {
    throw new Error("passwords don't match");
  }
  return first;
}

function requireUser(store: Store, username: string | undefined) {
  if (!username) {
    throw new Error("username required");
  }
  const user = store.getUser(username);
  if (!user) {
    throw new Error(`no such user: ${username}`);
  }
  return user;
}

function formatDate(ms: number | null): string {
  if (ms === null) {
    return "never";
  }
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export async function runAdmin(store: Store, args: ParsedArgs): Promise<void> {
  const [group, action, first, second] = args.positional;
  const command = `${group} ${action}`;

  if (command === "user add") {
    if (!first) {
      throw new Error("username required");
    }
    if (store.getUser(first)) {
      throw new Error(`user ${first} already exists`);
    }
    const password = await passwordFrom(args);
    if (password.length < 8) {
      throw new Error("password must be at least 8 characters");
    }
    store.createUser(first, await hashPassword(password));
    console.log(`created user ${first}`);
    return;
  }
  if (command === "user passwd") {
    const user = requireUser(store, first);
    store.setPassword(user.id, await hashPassword(await passwordFrom(args)));
    console.log(`password changed for ${user.username}`);
    return;
  }
  if (command === "user list") {
    for (const user of store.listUsers()) {
      console.log(`${user.id}\t${user.username}\tcreated ${formatDate(user.created)}`);
    }
    return;
  }
  if (command === "user remove") {
    const user = requireUser(store, first);
    store.deleteUser(user.id);
    console.log(`removed ${user.username} and all their tokens`);
    return;
  }
  if (command === "token create") {
    const user = requireUser(store, first);
    const issued = issueToken(store, user.id, second ?? "api", "api");
    console.log(`token ${issued.id} for ${user.username} (shown once, store it now):\n\n  ${issued.token}\n`);
    return;
  }
  if (command === "token list") {
    for (const token of store.listTokens()) {
      const used = formatDate(token.lastUsed);
      console.log(`${token.id}\t${token.kind}\t${token.username}\t${token.name}\tlast used ${used}`);
    }
    return;
  }
  if (command === "token revoke") {
    if (!store.deleteToken(Number(first))) {
      throw new Error(`no token with id ${first}`);
    }
    console.log(`revoked token ${first}`);
    return;
  }
  throw new Error(`unknown command: ${command}\n${USAGE}`);
}
