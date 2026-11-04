// Settings tab: server address, login/logout, what to sync.
// Declarative (Obsidian 1.13+): Obsidian renders the rows and indexes them for settings search.

import { Platform, PluginSettingTab, type App, type Setting, type SettingDefinitionItem } from "obsidian";
import { VaultClient, errorMessage } from "@mcp-vault/core";
import { LoginModal } from "./login-modal.ts";
import type VaultSyncPlugin from "./main.ts";
import { notify } from "./notify.ts";
import { obsidianHttp } from "./obsidian-http.ts";

export interface SyncSettings {
  serverUrl: string;
  /** Empty when logged out. */
  token: string;
  tokenId: number;
  username: string;
  deviceName: string;
  autoSync: boolean;
  syncConfig: boolean;
  /** One pattern per line, gitignore style. */
  excludes: string;
  pollSeconds: number;
}

type SettingKey = keyof SyncSettings;

/** Changing these changes what counts as syncable, so the whole change feed is read again. */
const FILTER_KEYS: SettingKey[] = ["syncConfig", "excludes"];

const MIN_POLL_SECONDS = 10;

function defaultDeviceName(): string {
  if (Platform.isMobile) {
    return "Mobile";
  }
  return "Desktop";
}

export const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "",
  token: "",
  tokenId: 0,
  username: "",
  deviceName: defaultDeviceName(),
  autoSync: true,
  syncConfig: false,
  excludes: "",
  pollSeconds: 60,
};

export class SyncSettingTab extends PluginSettingTab {
  private plugin: VaultSyncPlugin;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private get loggedIn(): boolean {
    return this.plugin.settings.token !== "";
  }

  getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
    return [
      {
        name: "Server URL",
        desc: "Address of your mcp-vault server. Mobile needs HTTPS. Log out to change it.",
        control: {
          type: "text",
          key: "serverUrl",
          placeholder: "https://notes.example.com",
          disabled: () => this.loggedIn,
        },
      },
      {
        name: "Test connection",
        desc: "Check that the server is reachable.",
        render: (setting) => {
          setting.addButton((button) => {
            button.setButtonText("Test").onClick(() => this.testConnection());
          });
        },
      },
      {
        name: "Account",
        render: (setting) => {
          if (this.loggedIn) {
            this.renderLoggedIn(setting);
          } else {
            this.renderLoggedOut(setting);
          }
        },
      },
      {
        type: "group",
        heading: "Sync",
        visible: () => this.loggedIn,
        items: [
          {
            name: "Sync automatically",
            desc: "Sync shortly after every change, and whenever the server reports one.",
            control: { type: "toggle", key: "autoSync" },
          },
          {
            name: "Sync settings folder",
            desc:
              `Also sync ${this.app.vault.configDir}: settings, themes, snippets, hotkeys and plugins. ` +
              "Window layout and this plugin's login always stay on this device.",
            control: { type: "toggle", key: "syncConfig" },
          },
          {
            name: "Check every (seconds)",
            desc: "Fallback when the live connection is down.",
            control: {
              type: "number",
              key: "pollSeconds",
              min: MIN_POLL_SECONDS,
              validate: (value) => {
                if (Number.isNaN(value) || value < MIN_POLL_SECONDS) {
                  return `At least ${MIN_POLL_SECONDS} seconds.`;
                }
                // Empty means valid.
                return "";
              },
            },
          },
          {
            name: "Full resync",
            desc: "Re-check every file. Nothing is deleted; differences become conflict copies.",
            render: (setting) => {
              setting.addButton((button) => {
                button.setButtonText("Resync").onClick(() => this.plugin.fullResync());
              });
            },
          },
          // Textareas break the row rhythm, so this one goes last.
          {
            name: "Exclude",
            desc: 'One pattern per line, e.g. "Private/" or "*.mp4".',
            control: { type: "textarea", key: "excludes", rows: 4 },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return Reflect.get(this.plugin.settings, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    let stored = value;
    if (key === "serverUrl" && typeof value === "string") {
      stored = value.trim();
    }
    Reflect.set(this.plugin.settings, key, stored);
    const filterChanged = FILTER_KEYS.some((filterKey) => filterKey === key);
    await this.plugin.saveSettings({ filterChanged });
  }

  private renderLoggedIn(setting: Setting): void {
    const settings = this.plugin.settings;
    setting.setDesc(
      `Logged in as ${settings.username} on "${settings.deviceName}". ${this.plugin.statusText}`,
    );
    setting.addButton((button) => {
      button.setButtonText("Sync now").onClick(() => this.plugin.syncNow(true));
    });
    setting.addButton((button) => {
      button
        .setButtonText("Log out")
        .setDestructive()
        .onClick(async () => {
          await this.plugin.logout();
          this.update();
        });
    });
  }

  private renderLoggedOut(setting: Setting): void {
    setting.setDesc("Not logged in.");
    setting.addButton((button) => {
      button
        .setButtonText("Log in")
        .setCta()
        .onClick(() => {
          new LoginModal(this.app, this.plugin, () => this.update()).open();
        });
    });
  }

  private async testConnection(): Promise<void> {
    const client = new VaultClient({ baseUrl: this.plugin.settings.serverUrl, http: obsidianHttp });
    try {
      const status = await client.status();
      notify(`Connected to ${status.name} (API v${status.apiVersion})`);
    } catch (error) {
      notify(`Can't reach server: ${errorMessage(error)}`);
    }
  }
}
