// The sync engine's view of the vault.
// Normal notes go through the Vault API so Obsidian updates its cache, editors and links.
// The config folder (.obsidian) is invisible to that API, so it goes through the raw adapter.

import { TFile, TFolder, type App } from "obsidian";
import type { LocalFile, LocalFs, LocalStat, SyncFilter } from "@mcp-vault/core";
import { toArrayBuffer } from "./obsidian-http.ts";

export class ObsidianFs implements LocalFs {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  private get configDir(): string {
    return this.app.vault.configDir;
  }

  private isConfigPath(path: string): boolean {
    return path === this.configDir || path.startsWith(this.configDir + "/");
  }

  async list(filter: SyncFilter): Promise<LocalFile[]> {
    const files: LocalFile[] = [];
    for (const file of this.app.vault.getFiles()) {
      if (filter.allows(file.path)) {
        files.push({ path: file.path, mtime: file.stat.mtime, size: file.stat.size });
      }
    }
    if (filter.allowsFolder(this.configDir)) {
      await this.listConfigFolder(this.configDir, filter, files);
    }
    return files;
  }

  private async listConfigFolder(folder: string, filter: SyncFilter, out: LocalFile[]): Promise<void> {
    const adapter = this.app.vault.adapter;
    const listing = await adapter.list(folder);
    for (const path of listing.files) {
      if (!filter.allows(path)) {
        continue;
      }
      const stat = await adapter.stat(path);
      if (stat && stat.type === "file") {
        out.push({ path, mtime: stat.mtime, size: stat.size });
      }
    }
    for (const subfolder of listing.folders) {
      if (filter.allowsFolder(subfolder)) {
        await this.listConfigFolder(subfolder, filter, out);
      }
    }
  }

  async stat(path: string): Promise<LocalStat | null> {
    const stat = await this.app.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") {
      return null;
    }
    return { mtime: stat.mtime, size: stat.size };
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.app.vault.adapter.readBinary(path));
  }

  async write(path: string, data: Uint8Array): Promise<LocalStat> {
    const buffer = toArrayBuffer(data);
    if (this.isConfigPath(path)) {
      await this.ensureAdapterFolder(parentOf(path));
      await this.app.vault.adapter.writeBinary(path, buffer);
    } else {
      const existing = this.app.vault.getFileByPath(path);
      if (existing) {
        await this.app.vault.modifyBinary(existing, buffer);
      } else {
        await this.ensureVaultFolder(parentOf(path));
        await this.app.vault.createBinary(path, buffer);
      }
    }
    const stat = await this.stat(path);
    if (!stat) {
      throw new Error(`could not write ${path}`);
    }
    return stat;
  }

  async remove(path: string): Promise<void> {
    if (this.isConfigPath(path)) {
      await this.app.vault.adapter.remove(path);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return;
    }
    const parent = file.parent;
    // Respects the user's "deleted files" setting (system trash, .trash, or permanent).
    await this.app.fileManager.trashFile(file);
    await this.removeEmptyFolders(parent);
  }

  private async removeEmptyFolders(folder: TFolder | null): Promise<void> {
    let current = folder;
    while (current && !current.isRoot() && current.children.length === 0) {
      const parent = current.parent;
      await this.app.vault.delete(current);
      current = parent;
    }
  }

  private async ensureVaultFolder(folder: string): Promise<void> {
    if (folder === "" || this.app.vault.getFolderByPath(folder)) {
      return;
    }
    await this.ensureVaultFolder(parentOf(folder));
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // Created meanwhile (or exists on disk but not cached yet) – fine either way.
    }
  }

  private async ensureAdapterFolder(folder: string): Promise<void> {
    if (folder === "" || (await this.app.vault.adapter.exists(folder))) {
      return;
    }
    await this.app.vault.adapter.mkdir(folder);
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash === -1) {
    return "";
  }
  return path.slice(0, slash);
}
