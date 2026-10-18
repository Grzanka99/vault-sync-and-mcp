// Settings come from flags first, then environment variables, then defaults.

import * as nodePath from "node:path";

export interface Config {
  vaultDir: string;
  dataDir: string;
  host: string;
  port: number;
  excludes: string[];
  maxUploadBytes: number;
  trustProxy: boolean;
  rescanMinutes: number;
  historyDays: number;
}

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
}

/** `--name value` and `--name=value`; a flag with no value becomes "true". */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), "true");
    }
  }
  return { positional, flags };
}

function pick(flags: Map<string, string>, flag: string, env: string, fallback: string): string {
  return flags.get(flag) ?? process.env[env] ?? fallback;
}

export function loadConfig(flags: Map<string, string>): Config {
  const vaultDir = nodePath.resolve(pick(flags, "vault", "MCP_VAULT_DIR", "./vault"));
  const dataDir = nodePath.resolve(pick(flags, "data", "MCP_VAULT_DATA", "./data"));
  const excludes = pick(flags, "exclude", "MCP_VAULT_EXCLUDE", "")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");

  // Data folder inside the vault? Then never sync it.
  const relativeData = nodePath.relative(vaultDir, dataDir);
  if (relativeData !== "" && !relativeData.startsWith("..") && !nodePath.isAbsolute(relativeData)) {
    excludes.push(`/${relativeData.split(nodePath.sep).join("/")}/`);
  }

  return {
    vaultDir,
    dataDir,
    host: pick(flags, "host", "HOST", "127.0.0.1"),
    port: Number(pick(flags, "port", "PORT", "8787")),
    excludes,
    maxUploadBytes: Number(pick(flags, "max-upload-mb", "MCP_VAULT_MAX_UPLOAD_MB", "200")) * 1024 * 1024,
    trustProxy: pick(flags, "trust-proxy", "MCP_VAULT_TRUST_PROXY", "false") === "true",
    rescanMinutes: Number(pick(flags, "rescan-minutes", "MCP_VAULT_RESCAN_MINUTES", "5")),
    historyDays: Number(pick(flags, "history-days", "MCP_VAULT_HISTORY_DAYS", "30")),
  };
}
