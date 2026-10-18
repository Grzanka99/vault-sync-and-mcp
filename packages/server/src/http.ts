// HTTP API for sync clients, plus the MCP endpoint. Plain node:http, no framework.

import * as http from "node:http";
import { API_VERSION, normalizePath, type StatusResponse } from "@mcp-vault/core";
import { FailureLimiter, hashPassword, issueToken, resolveToken, verifyPassword } from "./auth.ts";
import { attachLive } from "./live.ts";
import { handleMcpRequest } from "./mcp.ts";
import type { Store } from "./store.ts";
import { VaultError, type Actor, type Vault } from "./vault.ts";

export interface HttpOptions {
  vault: Vault;
  store: Store;
  maxUploadBytes: number;
  /** Use X-Forwarded-For for the client address (only behind a reverse proxy you control). */
  trustProxy: boolean;
  /** Token for agents on this machine, see loadLocalAgentToken. */
  localToken: string | null;
}

type Request = http.IncomingMessage;
type Response = http.ServerResponse;

const JSON_LIMIT = 1024 * 1024;
// Compared against when the username doesn't exist, so timing doesn't reveal valid usernames.
const dummyHash = hashPassword("not-a-real-password");

export function createHttpServer(options: HttpOptions): http.Server {
  const loginLimiter = new FailureLimiter(10, 5 * 60 * 1000);
  const server = http.createServer((request, response) => {
    handle(request, response, options, loginLimiter).catch((error) => sendError(response, error));
  });
  attachLive(server, options.vault, options.store, options.localToken);
  return server;
}

async function handle(
  request: Request,
  response: Response,
  options: HttpOptions,
  loginLimiter: FailureLimiter,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = `${request.method} ${url.pathname}`;
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  if (route === "GET /api/status") {
    const status: StatusResponse = {
      name: "mcp-vault",
      apiVersion: API_VERSION,
      vaultId: options.store.vaultId,
    };
    sendJson(response, 200, status);
    return;
  }
  if (route === "POST /api/login") {
    await login(request, response, options, loginLimiter);
    return;
  }

  const token = resolveToken(options.store, bearerToken(request), options.localToken);
  if (!token) {
    sendJson(response, 401, { error: "not logged in" });
    return;
  }
  const actor: Actor = { id: String(token.id), name: token.name };
  const { vault, store } = options;

  if (url.pathname === "/mcp") {
    let body: unknown = undefined;
    if (request.method === "POST") {
      body = JSON.parse((await readBody(request, JSON_LIMIT)).toString("utf8"));
    }
    await handleMcpRequest(request, response, body, vault, actor);
    return;
  }

  switch (route) {
    case "GET /api/me": {
      sendJson(response, 200, { username: token.username, tokenId: token.id, deviceName: token.name });
      return;
    }
    case "POST /api/logout": {
      store.deleteToken(token.id);
      sendJson(response, 200, { ok: true });
      return;
    }
    case "GET /api/changes": {
      const since = Number(url.searchParams.get("since") ?? 0);
      sendJson(response, 200, vault.changes(since));
      return;
    }
    case "GET /api/file": {
      const { data, entry } = await vault.read(pathParam(url));
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": data.byteLength,
        "x-hash": entry.hash,
        "x-size": entry.size,
        "x-mtime": entry.mtime,
        "x-seq": entry.seq,
      });
      response.end(data);
      return;
    }
    case "PUT /api/file": {
      const data = await readBody(request, options.maxUploadBytes);
      const base = headerValue(request, "x-base-hash") || null;
      sendJson(response, 200, await vault.put(pathParam(url), data, base, actor));
      return;
    }
    case "DELETE /api/file": {
      const base = url.searchParams.get("base") || null;
      sendJson(response, 200, await vault.remove(pathParam(url), base, actor));
      return;
    }
  }
  sendJson(response, 404, { error: `no route ${route}` });
}

async function login(
  request: Request,
  response: Response,
  options: HttpOptions,
  loginLimiter: FailureLimiter,
): Promise<void> {
  const address = clientAddress(request, options.trustProxy);
  if (loginLimiter.isBlocked(address)) {
    sendJson(response, 429, { error: "too many login attempts, try again in a few minutes" });
    return;
  }
  const body: unknown = JSON.parse((await readBody(request, JSON_LIMIT)).toString("utf8"));
  const username = stringField(body, "username").trim();
  const password = stringField(body, "password");
  let deviceName = stringField(body, "deviceName").trim().slice(0, 64);
  if (deviceName === "") {
    deviceName = "device";
  }

  const user = options.store.getUser(username);
  let valid = false;
  if (user) {
    valid = await verifyPassword(password, user.pwHash);
  } else {
    await verifyPassword(password, await dummyHash);
  }
  if (!user || !valid) {
    loginLimiter.recordFailure(address);
    sendJson(response, 401, { error: "wrong username or password" });
    return;
  }
  const issued = issueToken(options.store, user.id, deviceName, "device");
  sendJson(response, 200, { token: issued.token, tokenId: issued.id, username: user.username, deviceName });
}

// ── helpers ──

function stringField(body: unknown, key: string): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const value: unknown = Reflect.get(body, key);
  if (typeof value !== "string") {
    return "";
  }
  return value;
}

function pathParam(url: URL): string {
  const path = normalizePath(url.searchParams.get("path") ?? "");
  if (path === "") {
    throw new VaultError(400, "missing ?path=");
  }
  return path;
}

function headerValue(request: Request, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function bearerToken(request: Request): string | null {
  const header = headerValue(request, "authorization");
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return null;
  }
  return header.slice(prefix.length).trim();
}

function clientAddress(request: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = headerValue(request, "x-forwarded-for").split(",")[0].trim();
    if (forwarded !== "") {
      return forwarded;
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}

function readBody(request: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new VaultError(413, `body larger than ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function setCors(response: Response): void {
  // Auth is a bearer token, not cookies, so allowing any origin is safe.
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, x-base-hash, mcp-session-id",
  );
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("access-control-expose-headers", "x-hash, x-size, x-mtime, x-seq");
}

function sendJson(response: Response, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendError(response: Response, error: unknown): void {
  let status = 500;
  let message = "internal error";
  if (error instanceof VaultError) {
    status = error.status;
    message = error.message;
  } else if (error instanceof SyntaxError) {
    status = 400;
    message = "invalid JSON";
  } else {
    console.error("http:", error);
  }
  if (response.headersSent) {
    response.end();
    return;
  }
  sendJson(response, status, { error: message });
}
