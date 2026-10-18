// Obsidian plugin: wires the shared sync engine to the vault, the server and the UI.

import { Plugin } from "obsidian";
import {
  ApiError,
  NetworkError,
  SyncEngine,
  VaultClient,
  createClientFilter,
  emptyState,
  errorMessage,
  type ServerEvent,
  type SyncReport,
  type SyncState,
} from "@mcp-vault/core";
import { LiveConnection } from "./live.ts";
import { notify } from "./notify.ts";
import { ObsidianFs } from "./obsidian-fs.ts";
import { obsidianHttp } from "./obsidian-http.ts";
import { DEFAULT_SETTINGS, SyncSettingTab, type SyncSettings } from "./settings.ts";

/** Wait this long after the last edit before syncing, so typing doesn't sync every keystroke. */
const EDIT_DEBOUNCE_MS = 1500;
const REMOTE_DEBOUNCE_MS = 200;
/** Settings fields save on every keystroke; reconnect once typing stops. */
const SETTINGS_DEBOUNCE_MS = 1000;

export default class VaultSyncPlugin extends Plugin {
  settings: SyncSettings = { ...DEFAULT_SETTINGS };
  statusText = "";
  private state: SyncState = emptyState();
  private engine: SyncEngine | null = null;
  private live: LiveConnection | null = null;
  private syncTimer: number | null = null;
  private pollTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private statusBar: HTMLElement | null = null;
  private reportedErrors = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.state = await this.loadState();

    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.statusBar = this.addStatusBarItem();
    this.addRibbonIcon("refresh-cw", "Sync vault now", () => this.syncNow(true));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow(true) });
    this.addCommand({ id: "full-resync", name: "Full resync", callback: () => this.fullResync() });

    this.app.workspace.onLayoutReady(() => {
      this.watchVault();
      this.connect();
    });
  }

  onunload(): void {
    this.clearTimer(this.reconnectTimer);
    this.disconnect();
  }

  /** This plugin's folder inside the config folder, e.g. ".obsidian/plugins/mcp-vault-sync". */
  private get pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  // ── connection ──

  private connect(): void {
    this.disconnect();
    if (!this.settings.serverUrl || !this.settings.token) {
      this.setStatus("not logged in");
      return;
    }
    const client = new VaultClient({
      baseUrl: this.settings.serverUrl,
      token: this.settings.token,
      http: obsidianHttp,
    });
    const filter = createClientFilter({
      configDir: this.app.vault.configDir,
      syncConfig: this.settings.syncConfig,
      pluginDir: this.pluginDir,
      excludes: this.settings.excludes.split("\n"),
    });
    this.engine = new SyncEngine({
      fs: new ObsidianFs(this.app),
      remote: client,
      filter,
      state: this.state,
      saveState: (state) => this.saveState(state),
    });

    this.live = new LiveConnection(client.liveUrl(), (event) => this.onServerEvent(event));
    this.live.start();
    this.pollTimer = window.setInterval(() => {
      if (this.settings.autoSync) {
        void this.syncNow(false);
      }
    }, this.settings.pollSeconds * 1000);
    void this.syncNow(false);
  }

  private disconnect(): void {
    this.live?.stop();
    this.live = null;
    this.engine = null;
    this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    this.clearTimer(this.syncTimer);
    this.syncTimer = null;
  }

  private clearTimer(timer: number | null): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    }
  }

  private onServerEvent(event: ServerEvent): void {
    if (!this.settings.autoSync) {
      return;
    }
    if (event.type === "hello" && event.seq <= this.state.cursor) {
      return;
    }
    // Our own uploads echo back; nothing new to pull.
    if (event.type === "changed" && event.origin === String(this.settings.tokenId)) {
      return;
    }
    this.scheduleSync(REMOTE_DEBOUNCE_MS);
  }

  private watchVault(): void {
    const onChange = () => {
      if (this.settings.autoSync) {
        this.scheduleSync(EDIT_DEBOUNCE_MS);
      }
    };
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));
    // Phones suspend apps: catch up as soon as we're visible again.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.live?.wake();
        onChange();
      }
    });
  }

  private scheduleSync(delayMs: number): void {
    this.clearTimer(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow(false);
    }, delayMs);
  }

  // ── syncing ──

  async syncNow(manual: boolean): Promise<void> {
    if (!this.engine) {
      if (manual) {
        notify("MCP Vault Sync: log in first (Settings → MCP Vault Sync)");
      }
      return;
    }
    this.setStatus("syncing…");
    try {
      const report = await this.engine.sync();
      this.state = this.engine.state;
      this.setStatus(`synced ${new Date().toLocaleTimeString()}`);
      this.announce(report, manual);
    } catch (error) {
      await this.handleSyncError(error, manual);
    }
  }

  private announce(report: SyncReport, manual: boolean): void {
    for (const copy of report.conflicts) {
      notify(`Sync conflict: both versions kept, the other one is in "${copy}"`, 10_000);
    }
    for (const failure of report.errors) {
      // A broken file fails on every pass; say so once, not every few seconds.
      const key = `${failure.path}\n${failure.error}`;
      if (!this.reportedErrors.has(key)) {
        this.reportedErrors.add(key);
        notify(`Sync failed for ${failure.path}: ${failure.error}`);
      }
    }
    if (manual) {
      const changed = report.uploaded.length + report.downloaded.length + report.deleted.length;
      notify(`Sync done: ${changed} file(s) changed`);
    }
  }

  private async handleSyncError(error: unknown, manual: boolean): Promise<void> {
    if (error instanceof ApiError && error.status === 401) {
      this.setStatus("logged out");
      notify("MCP Vault Sync: login expired or revoked – log in again in settings");
      await this.clearLogin();
      return;
    }
    if (error instanceof NetworkError) {
      this.setStatus("offline");
      if (manual) {
        notify(`Can't reach the server: ${error.message}`);
      }
      return;
    }
    this.setStatus("error");
    notify(`Sync error: ${errorMessage(error)}`);
  }

  async fullResync(): Promise<void> {
    this.state = emptyState();
    await this.saveState(this.state);
    this.connect();
  }

  private setStatus(text: string): void {
    this.statusText = text;
    this.statusBar?.setText(`Vault sync: ${text}`);
  }

  // ── login ──

  async onLoggedIn(token: string, tokenId: number, username: string): Promise<void> {
    this.settings.token = token;
    this.settings.tokenId = tokenId;
    this.settings.username = username;
    await this.saveData(this.settings);
    this.connect();
  }

  async logout(): Promise<void> {
    const client = new VaultClient({
      baseUrl: this.settings.serverUrl,
      token: this.settings.token,
      http: obsidianHttp,
    });
    try {
      await client.logout();
    } catch {
      // Server unreachable or token already gone – forget it locally anyway.
    }
    await this.clearLogin();
  }

  private async clearLogin(): Promise<void> {
    this.disconnect();
    this.settings.token = "";
    this.settings.tokenId = 0;
    await this.saveData(this.settings);
    this.setStatus("not logged in");
  }

  // ── persistence ──

  async loadSettings(): Promise<void> {
    const saved: unknown = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS };
    if (typeof saved === "object" && saved !== null) {
      Object.assign(this.settings, saved);
    }
  }

  /** `filterChanged`: what counts as syncable changed, so re-read the whole change feed. */
  async saveSettings(options: { filterChanged?: boolean } = {}): Promise<void> {
    await this.saveData(this.settings);
    if (options.filterChanged) {
      this.state.cursor = 0;
      await this.saveState(this.state);
    }
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.settings.token) {
        this.connect();
      }
    }, SETTINGS_DEBOUNCE_MS);
  }

  // Kept apart from data.json: it can get big and changes on every sync.
  private get statePath(): string {
    return `${this.pluginDir}/sync-state.json`;
  }

  private async loadState(): Promise<SyncState> {
    try {
      const raw = await this.app.vault.adapter.read(this.statePath);
      const parsed: unknown = JSON.parse(raw);
      if (isSyncState(parsed)) {
        return parsed;
      }
    } catch {
      // First run or unreadable state: start fresh. Nothing is lost, files are compared by hash.
    }
    return emptyState();
  }

  private async saveState(state: SyncState): Promise<void> {
    await this.app.vault.adapter.write(this.statePath, JSON.stringify(state));
  }
}

function isSyncState(value: unknown): value is SyncState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof Reflect.get(value, "cursor") === "number" && typeof Reflect.get(value, "files") === "object";
}
