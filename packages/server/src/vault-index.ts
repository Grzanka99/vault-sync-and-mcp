// Keeps the SQLite index in step with the files on disk.
// The disk is the truth: anything that changes a file (sync client, MCP, an agent editing the folder
// directly) ends up here as a new version with a fresh `seq`, which is what clients pull.

import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import {
  DEFAULT_EXCLUDES,
  PathFilter,
  decodeText,
  fileName,
  isMarkdown,
  isMergeable,
  isSafePath,
  type FileEntry,
} from "@mcp-vault/core";
import { VaultError } from "./errors.ts";
import type { Store } from "./store.ts";
import { sha256, statOrNull, toAbsolute, walk } from "./vault-disk.ts";

/** Who made a change. `id` is the token id for clients, so they can ignore their own echoes. */
export interface Actor {
  id: string;
  name: string;
}

export const DISK_ACTOR: Actor = { id: "disk", name: "server" };

export interface VaultChange {
  entry: FileEntry;
  actor: Actor;
}

/** Mergeable text bigger than this is not kept in history (so it can't be 3-way merged). */
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

function titleOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return name;
  }
  return name.slice(0, dot);
}

export class VaultIndex extends EventEmitter<{ change: [VaultChange] }> {
  readonly root: string;
  readonly store: Store;
  private filter: PathFilter;

  constructor(root: string, store: Store, excludes: string[]) {
    super();
    this.root = root;
    this.store = store;
    this.filter = new PathFilter([...DEFAULT_EXCLUDES, ...excludes]);
  }

  isAllowed(relative: string): boolean {
    return isSafePath(relative) && !this.filter.excludes(relative);
  }

  isAllowedFolder(relative: string): boolean {
    return !this.filter.excludes(relative, true);
  }

  /** Validated absolute path; throws a 400 for anything outside the vault or excluded. */
  absolute(relative: string): string {
    if (!this.isAllowed(relative)) {
      throw new VaultError(400, `path not allowed: ${relative}`);
    }
    return toAbsolute(this.root, relative);
  }

  /** Walk the whole vault, picking up changes made while nobody was watching. */
  async scanAll(): Promise<void> {
    await this.scanFolder("");
  }

  /** Re-index one folder ("" = everything): new/changed files get recorded, vanished ones deleted. */
  async scanFolder(relativeFolder: string): Promise<void> {
    const seen = new Set<string>();
    const allow = (relative: string, isFolder: boolean) => {
      if (isFolder) {
        return this.isAllowedFolder(relative);
      }
      return this.isAllowed(relative);
    };
    await walk(this.root, relativeFolder, allow, async (relative, stat) => {
      seen.add(relative);
      await this.ingestFile(relative, stat);
    });

    let indexed = this.store.liveFiles();
    if (relativeFolder !== "") {
      indexed = this.store.liveFiles(relativeFolder);
    }
    for (const entry of indexed) {
      // Files excluded later stay in the index: deleting them would delete them on every client.
      if (!seen.has(entry.path) && this.isAllowed(entry.path)) {
        this.recordDelete(entry.path, DISK_ACTOR);
      }
    }
  }

  /** Bring one path (file or folder) up to date with the disk. */
  async ingest(relative: string): Promise<void> {
    const stat = await statOrNull(toAbsolute(this.root, relative));
    if (!stat) {
      this.forgetMissing(relative);
      return;
    }
    if (stat.isDirectory()) {
      await this.scanFolder(relative);
      return;
    }
    if (stat.isFile() && this.isAllowed(relative)) {
      await this.ingestFile(relative, stat);
    }
  }

  private async ingestFile(relative: string, stat: Stats): Promise<void> {
    const mtime = Math.floor(stat.mtimeMs);
    const current = this.store.liveFile(relative);
    if (current && current.size === stat.size && current.mtime === mtime) {
      return;
    }
    const data = await fsp.readFile(toAbsolute(this.root, relative));
    const hash = sha256(data);
    if (current && current.hash === hash) {
      this.store.touch(relative, mtime);
      return;
    }
    this.record(relative, data, mtime, DISK_ACTOR);
  }

  /** A path vanished: it was a file, or a folder whose files are all gone now. */
  private forgetMissing(relative: string): void {
    if (this.store.liveFile(relative)) {
      this.recordDelete(relative, DISK_ACTOR);
    }
    for (const entry of this.store.liveFiles(relative)) {
      this.recordDelete(entry.path, DISK_ACTOR);
    }
  }

  /** Store a new version of a file that is already on disk with this content. */
  record(relative: string, data: Uint8Array, mtime: number, actor: Actor): FileEntry {
    const entry: FileEntry = {
      path: relative,
      hash: sha256(data),
      size: data.byteLength,
      mtime,
      seq: 0,
      deleted: false,
      device: actor.name,
    };
    this.store.tx(() => {
      entry.seq = this.store.nextSeq();
      this.store.upsertFile(entry);
      this.store.addHistory(relative, entry.hash, entry.seq, actor.name);
      if (isMergeable(relative) && data.byteLength <= MAX_BLOB_BYTES) {
        this.store.putBlob(entry.hash, data);
      }
      if (isMarkdown(relative)) {
        this.store.ftsUpsert(relative, titleOf(relative), decodeText(data));
      }
    });
    this.emit("change", { entry, actor });
    return entry;
  }

  /** Mark a file deleted. The row stays as a tombstone so offline clients learn about it. */
  recordDelete(relative: string, actor: Actor): FileEntry {
    const previous = this.store.getFile(relative);
    const entry: FileEntry = {
      path: relative,
      hash: previous?.hash ?? "",
      size: 0,
      mtime: Date.now(),
      seq: 0,
      deleted: true,
      device: actor.name,
    };
    this.store.tx(() => {
      entry.seq = this.store.nextSeq();
      this.store.upsertFile(entry);
      this.store.addHistory(relative, null, entry.seq, actor.name);
      this.store.ftsDelete(relative);
    });
    this.emit("change", { entry, actor });
    return entry;
  }
}
