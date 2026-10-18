// The vault: every read and write of notes goes through here, one at a time (see `lock`).
// Sync clients use put/remove/read. MCP tools use writeNote/deleteNote/moveNote.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import {
  conflictPath,
  isMergeable,
  isSafePath,
  type ChangesResponse,
  type DeleteResponse,
  type FileEntry,
  type PutResponse,
} from "@mcp-vault/core";
import { merge3 } from "./merge.ts";
import type { SearchHit, Store } from "./store.ts";
import {
  Mutex,
  assertNoSymlinkFolders,
  removeAndPrune,
  sha256,
  statOrNull,
  walk,
  writeAtomic,
} from "./vault-disk.ts";
import { VaultError } from "./errors.ts";
import { VaultIndex, type Actor } from "./vault-index.ts";

export { VaultError } from "./errors.ts";
export { DISK_ACTOR, type Actor, type VaultChange } from "./vault-index.ts";

export interface VaultOptions {
  root: string;
  store: Store;
  excludes?: string[];
  /** Full rescan interval, a safety net for missed watcher events. */
  rescanMinutes?: number;
  /** How long old versions are kept as merge bases / history. */
  historyDays?: number;
}

export interface ListedFile {
  path: string;
  size: number;
  mtime: number;
}

const WATCH_DEBOUNCE_MS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export class Vault {
  readonly index: VaultIndex;
  private store: Store;
  private lock = new Mutex();
  private options: VaultOptions;
  private watcher: fs.FSWatcher | null = null;
  private timers: NodeJS.Timeout[] = [];
  private pendingPaths = new Map<string, NodeJS.Timeout>();

  constructor(options: VaultOptions) {
    this.options = options;
    this.store = options.store;
    this.index = new VaultIndex(nodePath.resolve(options.root), options.store, options.excludes ?? []);
  }

  get root(): string {
    return this.index.root;
  }

  // ── lifecycle ──

  async start(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
    await this.lock.run(() => this.index.scanAll());
    this.startWatcher();

    const rescanMs = (this.options.rescanMinutes ?? 5) * 60 * 1000;
    this.timers.push(setInterval(() => this.queue(() => this.index.scanAll()), rescanMs));

    const historyMs = (this.options.historyDays ?? 30) * DAY_MS;
    const collectGarbage = () => this.store.gc(Date.now() - historyMs);
    collectGarbage();
    this.timers.push(setInterval(collectGarbage, DAY_MS));
  }

  stop(): void {
    this.watcher?.close();
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    for (const timer of this.pendingPaths.values()) {
      clearTimeout(timer);
    }
  }

  /** Run in the background, logging instead of throwing. */
  private queue(task: () => Promise<void>): void {
    this.lock.run(task).catch((error) => {
      console.error("vault:", error);
    });
  }

  /**
   * Agents may edit the folder directly. The watcher notices, and the change gets a new seq like
   * any other. Linux reports just the folder for some events, so ingest() handles folders too.
   */
  private startWatcher(): void {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        this.onDiskEvent(filename);
      });
      this.watcher.on("error", (error) => {
        console.error(`vault: watcher stopped (${error.message}); relying on periodic rescans`);
      });
    } catch (error) {
      console.error("vault: cannot watch folder, relying on periodic rescans:", error);
    }
  }

  private onDiskEvent(filename: string | null): void {
    let relative = "";
    if (filename) {
      relative = filename.split(nodePath.sep).join("/");
      if (!isSafePath(relative) || !this.index.isAllowed(relative)) {
        return;
      }
    }
    clearTimeout(this.pendingPaths.get(relative));
    const timer = setTimeout(() => {
      this.pendingPaths.delete(relative);
      if (relative === "") {
        this.queue(() => this.index.scanAll());
      } else {
        this.queue(() => this.index.ingest(relative));
      }
    }, WATCH_DEBOUNCE_MS);
    this.pendingPaths.set(relative, timer);
  }

  // ── reads ──

  changes(since: number, limit = 1000): ChangesResponse {
    const entries = this.store.changes(since, limit);
    const more = entries.length === limit;
    let cursor = this.store.currentSeq;
    if (more) {
      cursor = entries[entries.length - 1].seq;
    }
    return { vaultId: this.store.vaultId, entries, cursor, more };
  }

  read(relative: string): Promise<{ data: Uint8Array; entry: FileEntry }> {
    return this.lock.run(async () => {
      const current = await this.refresh(relative);
      if (!current) {
        throw new VaultError(404, `not found: ${relative}`);
      }
      const data = await fsp.readFile(this.index.absolute(relative));
      return { data, entry: current };
    });
  }

  /** Every file on disk under `folder` ("" = whole vault). */
  async list(folder = ""): Promise<ListedFile[]> {
    const files: ListedFile[] = [];
    const allow = (relative: string, isFolder: boolean) => {
      if (isFolder) {
        return this.index.isAllowedFolder(relative);
      }
      return this.index.isAllowed(relative);
    };
    await walk(this.root, folder, allow, async (relative, stat) => {
      files.push({ path: relative, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
    });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  search(query: string, limit = 20): SearchHit[] {
    return this.store.search(query, limit);
  }

  recent(limit = 20): FileEntry[] {
    return this.store.recent(limit);
  }

  // ── sync protocol writes ──

  /**
   * Store an upload. `baseHash` is what the client last synced:
   *  - matches the server copy (or nothing on the server) → fast-forward
   *  - otherwise both changed → 3-way merge text, or keep ours and save theirs as a conflict copy
   */
  put(relative: string, data: Uint8Array, baseHash: string | null, actor: Actor): Promise<PutResponse> {
    return this.lock.run(async () => {
      const current = await this.refresh(relative);
      const hash = sha256(data);

      if (current && current.hash === hash) {
        return { status: "unchanged", entry: current };
      }
      if (!current || current.hash === baseHash) {
        return { status: "ok", entry: await this.writeLocked(relative, data, actor) };
      }

      const merged = await this.tryMerge(relative, data, baseHash);
      if (merged) {
        return { status: "merged", entry: await this.writeLocked(relative, merged, actor) };
      }

      const copyPath = await this.freeConflictPath(relative, actor.name);
      await this.writeLocked(copyPath, data, actor);
      return { status: "conflict", entry: current, conflictPath: copyPath };
    });
  }

  /** Delete, unless the server copy changed since `baseHash` – then the edit wins. */
  remove(relative: string, baseHash: string | null, actor: Actor): Promise<DeleteResponse> {
    return this.lock.run(async () => {
      const current = await this.refresh(relative);
      if (!current) {
        return { status: "gone" };
      }
      if (current.hash !== baseHash) {
        return { status: "modified", entry: current };
      }
      return { status: "ok", entry: await this.deleteLocked(relative, actor) };
    });
  }

  // ── MCP writes ──

  /**
   * Write a whole file. `expectedHash`: undefined = overwrite whatever is there,
   * null = must not exist yet, string = must still be that version (optimistic locking).
   */
  writeNote(
    relative: string,
    data: Uint8Array,
    expectedHash: string | null | undefined,
    actor: Actor,
  ): Promise<FileEntry> {
    return this.lock.run(async () => {
      const current = await this.refresh(relative);
      this.checkExpected(relative, current, expectedHash);
      return this.writeLocked(relative, data, actor);
    });
  }

  deleteNote(relative: string, actor: Actor): Promise<void> {
    return this.lock.run(async () => {
      const current = await this.refresh(relative);
      if (!current) {
        throw new VaultError(404, `not found: ${relative}`);
      }
      await this.deleteLocked(relative, actor);
    });
  }

  moveNote(from: string, to: string, actor: Actor): Promise<FileEntry> {
    return this.lock.run(async () => {
      const source = await this.refresh(from);
      if (!source) {
        throw new VaultError(404, `not found: ${from}`);
      }
      if (await this.refresh(to)) {
        throw new VaultError(409, `already exists: ${to}`);
      }
      const data = await fsp.readFile(this.index.absolute(from));
      const entry = await this.writeLocked(to, data, actor);
      await this.deleteLocked(from, actor);
      return entry;
    });
  }

  // ── internals (call only while holding the lock) ──

  /** Make sure the index matches the disk for this path, then return its live entry. */
  private async refresh(relative: string): Promise<FileEntry | null> {
    this.index.absolute(relative);
    await assertNoSymlinkFolders(this.root, relative);
    await this.index.ingest(relative);
    return this.store.liveFile(relative);
  }

  private checkExpected(
    relative: string,
    current: FileEntry | null,
    expectedHash: string | null | undefined,
  ): void {
    if (expectedHash === undefined) {
      return;
    }
    if (expectedHash === null && current) {
      throw new VaultError(409, `already exists: ${relative}`);
    }
    if (expectedHash !== null && current?.hash !== expectedHash) {
      throw new VaultError(409, `${relative} changed since you read it – read it again and retry`);
    }
  }

  private async tryMerge(
    relative: string,
    ours: Uint8Array,
    baseHash: string | null,
  ): Promise<Uint8Array | null> {
    if (!isMergeable(relative) || !baseHash) {
      return null;
    }
    const base = this.store.getBlob(baseHash);
    if (!base) {
      return null;
    }
    const theirs = await fsp.readFile(this.index.absolute(relative));
    const merged = merge3(ours, base, theirs);
    if (merged === null) {
      return null;
    }
    return new TextEncoder().encode(merged);
  }

  private async freeConflictPath(relative: string, device: string): Promise<string> {
    let candidate = conflictPath(relative, device);
    let counter = 2;
    while (this.store.liveFile(candidate) || (await statOrNull(this.index.absolute(candidate)))) {
      candidate = conflictPath(relative, `${device} ${counter}`);
      counter++;
    }
    return candidate;
  }

  private async writeLocked(relative: string, data: Uint8Array, actor: Actor): Promise<FileEntry> {
    const absolute = this.index.absolute(relative);
    await assertNoSymlinkFolders(this.root, relative);
    const stat = await writeAtomic(absolute, data);
    return this.index.record(relative, data, Math.floor(stat.mtimeMs), actor);
  }

  private async deleteLocked(relative: string, actor: Actor): Promise<FileEntry> {
    await removeAndPrune(this.root, this.index.absolute(relative));
    return this.index.recordDelete(relative, actor);
  }
}
