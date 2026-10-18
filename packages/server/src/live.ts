// WebSocket push: tells connected clients "something changed, pull now".
// Clients still fetch changes over HTTP; this only removes polling delay.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerEvent } from "@mcp-vault/core";
import { resolveToken } from "./auth.ts";
import type { Store } from "./store.ts";
import type { Vault, VaultChange } from "./vault.ts";

/** Changes arriving within this window go out as one event. */
const COALESCE_MS = 100;
const PING_MS = 30_000;

export function attachLive(server: Server, vault: Vault, store: Store, localToken: string | null): void {
  const sockets = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }
    const token = resolveToken(store, url.searchParams.get("token"), localToken);
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      const hello: ServerEvent = { type: "hello", seq: store.currentSeq, vaultId: store.vaultId };
      ws.send(JSON.stringify(hello));
    });
  });

  // Drop connections that stopped answering (phone went to sleep, proxy cut it, …).
  const pinger = setInterval(() => {
    for (const ws of sockets.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_MS);
  server.on("close", () => clearInterval(pinger));

  let pending: { seq: number; origins: Set<string> } | null = null;

  function flush(): void {
    if (!pending) {
      return;
    }
    const event: ServerEvent = { type: "changed", seq: pending.seq };
    if (pending.origins.size === 1) {
      event.origin = [...pending.origins][0];
    }
    pending = null;
    const message = JSON.stringify(event);
    for (const ws of sockets.clients) {
      ws.send(message);
    }
  }

  vault.index.on("change", (change: VaultChange) => {
    if (!pending) {
      pending = { seq: 0, origins: new Set() };
      setTimeout(flush, COALESCE_MS);
    }
    pending.seq = Math.max(pending.seq, change.entry.seq);
    pending.origins.add(change.actor.id);
  });
}
