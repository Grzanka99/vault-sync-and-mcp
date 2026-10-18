import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import type { Store, TokenInfo } from "./store.ts";

function scryptAsync(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });
}

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // Format: scrypt$N$r$p$salt$key
  const [algorithm, n, r, p, salt, key] = stored.split("$");
  if (algorithm !== "scrypt") {
    return false;
  }
  const expected = Buffer.from(key, "base64");
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, params);
  return timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Tokens are shown once; only their hash is stored. */
export function issueToken(
  store: Store,
  userId: number,
  name: string,
  kind: TokenInfo["kind"],
): { token: string; id: number } {
  const token = `mv_${randomBytes(32).toString("base64url")}`;
  return { token, id: store.createToken(userId, name, kind, sha256(token)) };
}

const lastTouched = new Map<number, number>();

/** Who a request is when it comes with the local agent token. */
export const LOCAL_AGENT: TokenInfo = {
  id: 0,
  userId: 0,
  username: "local",
  name: "local agent",
  kind: "api",
  created: 0,
  lastUsed: null,
};

const LOCAL_TOKEN_FILE = "local-agent.token";

/**
 * Token for agents on the same machine (`mcp-vault mcp`). It lives in the data folder, readable
 * only by the user running the server, so "can read this file" is the permission check.
 */
export async function loadLocalAgentToken(dataDir: string, create: boolean): Promise<string | null> {
  const file = nodePath.join(dataDir, LOCAL_TOKEN_FILE);
  try {
    return (await fsp.readFile(file, "utf8")).trim();
  } catch {
    if (!create) {
      return null;
    }
  }
  const token = `mv_local_${randomBytes(32).toString("base64url")}`;
  await fsp.writeFile(file, token + "\n", { mode: 0o600 });
  return token;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(sha256(a));
  const right = Buffer.from(sha256(b));
  return timingSafeEqual(left, right);
}

export function resolveToken(
  store: Store,
  token: string | null | undefined,
  localToken: string | null,
): TokenInfo | null {
  if (!token) {
    return null;
  }
  if (localToken && sameSecret(token, localToken)) {
    return LOCAL_AGENT;
  }
  const info = store.findToken(sha256(token));
  if (info && !store.readOnly && Date.now() - (lastTouched.get(info.id) ?? 0) > 60_000) {
    lastTouched.set(info.id, Date.now());
    store.touchToken(info.id);
  }
  return info;
}

/** Counts failed logins per client address; blocks after `max` failures until the window ends. */
export class FailureLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();
  private max: number;
  private windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  isBlocked(key: string): boolean {
    const record = this.failures.get(key);
    if (!record) {
      return false;
    }
    if (record.resetAt < Date.now()) {
      this.failures.delete(key);
      return false;
    }
    return record.count >= this.max;
  }

  recordFailure(key: string): void {
    const record = this.failures.get(key);
    if (!record || record.resetAt < Date.now()) {
      this.failures.set(key, { count: 1, resetAt: Date.now() + this.windowMs });
      return;
    }
    record.count++;
  }
}
