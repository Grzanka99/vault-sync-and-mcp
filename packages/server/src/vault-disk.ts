// Low-level disk helpers for the vault folder. Paths passed in here are already validated.

import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { VaultError } from "./errors.ts";

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Absolute path for a vault-relative "a/b.md". */
export function toAbsolute(root: string, relative: string): string {
  return nodePath.join(root, ...relative.split("/"));
}

/** lstat that returns null instead of throwing when the path doesn't exist. */
export async function statOrNull(absolute: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(absolute);
  } catch {
    return null;
  }
}

/**
 * Refuse paths that go through a symlinked folder: otherwise a link inside the vault
 * could make the server read or write outside of it.
 */
export async function assertNoSymlinkFolders(root: string, relative: string): Promise<void> {
  const segments = relative.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = nodePath.join(current, segment);
    const stat = await statOrNull(current);
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new VaultError(400, `path goes through a symlink: ${relative}`);
    }
  }
}

/** Write to a temp file next to the target, then rename, so readers never see half a file. */
export async function writeAtomic(absolute: string, data: Uint8Array): Promise<Stats> {
  const folder = nodePath.dirname(absolute);
  await fsp.mkdir(folder, { recursive: true });
  const temp = nodePath.join(
    folder,
    `.${nodePath.basename(absolute)}.${randomBytes(4).toString("hex")}.mcpvault-tmp`,
  );
  await fsp.writeFile(temp, data);
  await fsp.rename(temp, absolute);
  return fsp.stat(absolute);
}

/** Delete a file, then remove parent folders that became empty (stopping at the vault root). */
export async function removeAndPrune(root: string, absolute: string): Promise<void> {
  await fsp.rm(absolute, { force: true });
  let folder = nodePath.dirname(absolute);
  while (folder !== root && folder.startsWith(root + nodePath.sep)) {
    try {
      await fsp.rmdir(folder);
    } catch {
      // Not empty (or already gone) – stop here.
      return;
    }
    folder = nodePath.dirname(folder);
  }
}

export type WalkFilter = (relative: string, isFolder: boolean) => boolean;
export type WalkVisitor = (relative: string, stat: Stats) => Promise<void>;

/** Visit every regular file under `relativeFolder` ("" = whole vault). Symlinks are skipped. */
export async function walk(
  root: string,
  relativeFolder: string,
  allow: WalkFilter,
  visit: WalkVisitor,
): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(toAbsolute(root, relativeFolder), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    let relative = entry.name;
    if (relativeFolder !== "") {
      relative = `${relativeFolder}/${entry.name}`;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (allow(relative, true)) {
        await walk(root, relative, allow, visit);
      }
      continue;
    }
    if (!entry.isFile() || !allow(relative, false)) {
      continue;
    }
    const stat = await statOrNull(toAbsolute(root, relative));
    if (stat) {
      await visit(relative, stat);
    }
  }
}

/** Runs async tasks one at a time, in the order they were queued. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
