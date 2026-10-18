// Keeps a WebSocket open to the server so changes made elsewhere arrive within a second.
// If it can't connect (e.g. plain ws:// blocked on iOS), polling in main.ts still keeps things in sync.

import type { ServerEvent } from "@mcp-vault/core";

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;

export class LiveConnection {
  private url: string;
  private onEvent: (event: ServerEvent) => void;
  private socket: WebSocket | null = null;
  private retryMs = MIN_RETRY_MS;
  private retryTimer: number | null = null;
  private stopped = false;

  constructor(url: string, onEvent: (event: ServerEvent) => void) {
    this.url = url;
    this.onEvent = onEvent;
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    this.socket?.close();
    this.socket = null;
  }

  /** Reconnect right away, e.g. when the app comes back to the foreground. */
  wake(): void {
    if (this.stopped || this.connected) {
      return;
    }
    this.clearRetry();
    this.retryMs = MIN_RETRY_MS;
    this.open();
  }

  private open(): void {
    this.socket?.close();
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retryMs = MIN_RETRY_MS;
    });
    socket.addEventListener("message", (message) => {
      this.handleMessage(message.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.scheduleRetry();
      }
    });
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(data);
      if (isServerEvent(parsed)) {
        this.onEvent(parsed);
      }
    } catch {
      // Ignore anything that isn't one of our events.
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) {
      return;
    }
    this.clearRetry();
    this.retryTimer = window.setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

function isServerEvent(value: unknown): value is ServerEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type: unknown = Reflect.get(value, "type");
  return type === "hello" || type === "changed";
}
