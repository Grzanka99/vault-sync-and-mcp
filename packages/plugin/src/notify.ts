import { Notice } from "obsidian";

/** Show a toast. Obsidian's API is `new Notice(...)` used only for its side effect. */
export function notify(message: string, timeoutMs?: number): void {
  // oxlint-disable-next-line no-new
  new Notice(message, timeoutMs);
}
