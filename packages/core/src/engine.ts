import { ApiError, type RemoteApi } from "./client.ts";
import { sha256Hex } from "./hash.ts";
import type { SyncFilter } from "./paths.ts";
import type { FileEntry } from "./protocol.ts";

export interface LocalStat {
  mtime: number;
  size: number;
}

export interface LocalFile extends LocalStat {
  path: string;
}

/** Client-side file access: Obsidian's Vault API in the plugin, node:fs in tests. */
export interface LocalFs {
  list(filter: SyncFilter): Promise<LocalFile[]>;
  stat(path: string): Promise<LocalStat | null>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<LocalStat>;
  remove(path: string): Promise<void>;
}

/** How a file looked locally the last time it matched the server. Its hash is the merge base. */
export interface SyncedFile {
  hash: string;
  mtime: number;
  size: number;
}

export interface SyncState {
  vaultId?: string;
  /** Last server `seq` we have fully applied. */
  cursor: number;
  files: Record<string, SyncedFile>;
}

export function emptyState(): SyncState {
  return { cursor: 0, files: {} };
}

export interface SyncReport {
  uploaded: string[];
  downloaded: string[];
  deleted: string[];
  merged: string[];
  conflicts: string[];
  errors: { path: string; error: string }[];
}

export function emptyReport(): SyncReport {
  return { uploaded: [], downloaded: [], deleted: [], merged: [], conflicts: [], errors: [] };
}

function appendReport(target: SyncReport, source: SyncReport): void {
  target.uploaded.push(...source.uploaded);
  target.downloaded.push(...source.downloaded);
  target.deleted.push(...source.deleted);
  target.merged.push(...source.merged);
  target.conflicts.push(...source.conflicts);
  target.errors.push(...source.errors);
}

type LocalChange = { kind: "upsert"; hash: string; stat: LocalStat } | { kind: "delete" };

export interface SyncEngineOptions {
  fs: LocalFs;
  remote: RemoteApi;
  filter: SyncFilter;
  state: SyncState;
  saveState: (state: SyncState) => Promise<void>;
}

/**
 * One sync pass:
 *   1. pull the server change feed since our cursor
 *   2. scan local files, hashing only the ones whose mtime/size moved
 *   3. apply remote changes to files we haven't touched locally
 *   4. push local changes, sending the last synced hash as the base; the server
 *      fast-forwards, 3-way merges, or writes a conflict copy, and we download its result
 */
export class SyncEngine {
  state: SyncState;
  private options: SyncEngineOptions;
  private running: Promise<SyncReport> | null = null;
  private runAgain = false;

  constructor(options: SyncEngineOptions) {
    this.options = options;
    this.state = options.state;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Calls made while a sync is running are folded into one extra pass. */
  sync(): Promise<SyncReport> {
    if (this.running) {
      this.runAgain = true;
      return this.running;
    }
    this.running = this.runUntilSettled();
    return this.running;
  }

  private async runUntilSettled(): Promise<SyncReport> {
    const total = emptyReport();
    try {
      do {
        this.runAgain = false;
        appendReport(total, await this.runOnce());
      } while (this.runAgain);
    } finally {
      this.running = null;
    }
    return total;
  }

  private async runOnce(): Promise<SyncReport> {
    const report = emptyReport();
    try {
      const pulled = await this.pullChanges();
      if (pulled === "vault-replaced") {
        return this.runOnce();
      }
      const local = await this.listLocal();
      const changed = await this.findLocalChanges(local);
      const applied = await this.applyRemoteChanges(pulled.changes, local, changed, report);
      await this.pushLocalChanges(changed, report);
      // Only move the cursor when every remote change landed; failed ones get retried next pass.
      if (applied) {
        this.state.cursor = pulled.cursor;
      }
      return report;
    } finally {
      await this.options.saveState(this.state);
    }
  }

  // ── 1. pull ──

  private async pullChanges(): Promise<
    { changes: Map<string, FileEntry>; cursor: number } | "vault-replaced"
  > {
    const changes = new Map<string, FileEntry>();
    let cursor = this.state.cursor;
    while (true) {
      const response = await this.options.remote.changes(cursor);
      if (this.state.vaultId && this.state.vaultId !== response.vaultId) {
        // The server was rebuilt from scratch, so our merge bases mean nothing there any more.
        this.state = { vaultId: response.vaultId, cursor: 0, files: {} };
        return "vault-replaced";
      }
      this.state.vaultId = response.vaultId;
      for (const entry of response.entries) {
        if (this.options.filter.allows(entry.path)) {
          changes.set(entry.path, entry);
        }
      }
      cursor = response.cursor;
      if (!response.more) {
        break;
      }
    }
    return { changes, cursor };
  }

  // ── 2. scan ──

  private async listLocal(): Promise<Map<string, LocalFile>> {
    const local = new Map<string, LocalFile>();
    for (const file of await this.options.fs.list(this.options.filter)) {
      if (this.options.filter.allows(file.path)) {
        local.set(file.path, file);
      }
    }
    return local;
  }

  private async findLocalChanges(local: Map<string, LocalFile>): Promise<Map<string, LocalChange>> {
    const files = this.state.files;
    const changed = new Map<string, LocalChange>();

    for (const [path, file] of local) {
      const synced = files[path];
      if (synced && synced.mtime === file.mtime && synced.size === file.size) {
        continue;
      }
      const hash = await sha256Hex(await this.options.fs.read(path));
      if (synced && synced.hash === hash) {
        // Touched but not changed: remember the new mtime so we don't hash it again.
        files[path] = { hash, mtime: file.mtime, size: file.size };
        continue;
      }
      changed.set(path, { kind: "upsert", hash, stat: { mtime: file.mtime, size: file.size } });
    }

    for (const path of Object.keys(files)) {
      if (!local.has(path) && this.options.filter.allows(path)) {
        changed.set(path, { kind: "delete" });
      }
    }
    return changed;
  }

  // ── 3. apply remote ──

  /** Returns false if any change failed to apply. */
  private async applyRemoteChanges(
    remoteChanges: Map<string, FileEntry>,
    local: Map<string, LocalFile>,
    changed: Map<string, LocalChange>,
    report: SyncReport,
  ): Promise<boolean> {
    const files = this.state.files;
    let allApplied = true;

    for (const [path, entry] of remoteChanges) {
      try {
        const localChange = changed.get(path);
        if (localChange) {
          // Both sides moved. If they agree, just record it; otherwise step 4 lets the server merge.
          if (localChange.kind === "upsert" && !entry.deleted && localChange.hash === entry.hash) {
            files[path] = { hash: entry.hash, ...localChange.stat };
            changed.delete(path);
          } else if (localChange.kind === "delete" && entry.deleted) {
            delete files[path];
            changed.delete(path);
          }
          continue;
        }

        if (entry.deleted) {
          if (local.has(path)) {
            if (!(await this.unchangedSince(path, files[path]))) {
              continue;
            }
            await this.options.fs.remove(path);
            report.deleted.push(path);
          }
          delete files[path];
          continue;
        }

        if (files[path]?.hash === entry.hash) {
          continue;
        }
        if (await this.download(path, files[path] ?? null)) {
          report.downloaded.push(path);
        }
      } catch (error) {
        allApplied = false;
        this.recordFailure(report, path, error);
      }
    }
    return allApplied;
  }

  // ── 4. push local ──

  private async pushLocalChanges(changed: Map<string, LocalChange>, report: SyncReport): Promise<void> {
    for (const [path, change] of changed) {
      try {
        if (change.kind === "delete") {
          await this.pushDelete(path, report);
        } else {
          await this.pushUpload(path, report);
        }
      } catch (error) {
        this.recordFailure(report, path, error);
      }
    }
  }

  private async pushDelete(path: string, report: SyncReport): Promise<void> {
    const base = this.state.files[path]?.hash ?? null;
    const response = await this.options.remote.remove(path, base);
    if (response.status === "modified") {
      // Someone edited it after we last synced: their edit wins over our delete.
      if (await this.download(path, null)) {
        report.downloaded.push(path);
      }
      return;
    }
    delete this.state.files[path];
    report.deleted.push(path);
  }

  private async pushUpload(path: string, report: SyncReport): Promise<void> {
    const base = this.state.files[path]?.hash ?? null;
    // Stat before reading: an edit landing after the stat changes the mtime and is caught next pass.
    const stat = await this.options.fs.stat(path);
    if (!stat) {
      return;
    }
    const data = await this.options.fs.read(path);
    const response = await this.options.remote.upload(path, data, base);

    if (response.status === "ok" || response.status === "unchanged") {
      this.state.files[path] = { hash: response.entry.hash, ...stat };
      if (response.status === "ok") {
        report.uploaded.push(path);
      }
      return;
    }

    if (response.status === "merged") {
      report.merged.push(path);
    } else {
      report.conflicts.push(response.conflictPath ?? path);
    }
    // The server holds a different version now (merged, or theirs + our conflict copy).
    await this.download(path, stat);
    if (response.conflictPath) {
      await this.download(response.conflictPath, null);
    }
  }

  // ── helpers ──

  /**
   * Overwrite a local file with the server copy, unless the user touched it since we looked
   * (`expected` = the stat we last saw, null = it didn't exist). Skipped files are retried next pass.
   */
  private async download(path: string, expected: LocalStat | null): Promise<boolean> {
    if (!(await this.unchangedSince(path, expected))) {
      return false;
    }
    const { data, entry } = await this.options.remote.download(path);
    const stat = await this.options.fs.write(path, data);
    this.state.files[path] = { hash: entry.hash, ...stat };
    return true;
  }

  private async unchangedSince(path: string, expected: LocalStat | null | undefined): Promise<boolean> {
    const now = await this.options.fs.stat(path);
    if (!expected) {
      return now === null;
    }
    return now !== null && now.mtime === expected.mtime && now.size === expected.size;
  }

  private recordFailure(report: SyncReport, path: string, error: unknown): void {
    // Lost connection or lost login: abort the whole pass instead of failing every file in turn.
    const isFileLevelError = error instanceof ApiError && error.status !== 401 && error.status !== 403;
    if (!isFileLevelError) {
      throw error;
    }
    report.errors.push({ path, error: error.message });
  }
}
