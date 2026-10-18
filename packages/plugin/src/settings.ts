// Settings tab: server address, login/logout, what to sync.
// The password is only kept while you type it; the server hands back a per-device token instead.

import { Platform, PluginSettingTab, Setting, type App } from "obsidian";
import { VaultClient, errorMessage } from "@mcp-vault/core";
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
  private loginUsername = "";
  private loginPassword = "";

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.showServer(containerEl);
    if (this.plugin.settings.token) {
      this.showAccount(containerEl);
      this.showSyncOptions(containerEl);
    } else {
      this.showLogin(containerEl);
    }
  }

  private showServer(container: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(container).setName("Server").setHeading();

    const urlSetting = new Setting(container)
      .setName("Server URL")
      .setDesc("Where mcp-vault runs, e.g. https://notes.example.com. Use HTTPS for mobile.");
    urlSetting.addText((text) => {
      text.setPlaceholder("https://…").setValue(settings.serverUrl);
      text.setDisabled(settings.token !== "");
      text.onChange(async (value) => {
        settings.serverUrl = value.trim();
        await this.plugin.saveSettings();
      });
    });
    urlSetting.addButton((button) => {
      button.setButtonText("Test").onClick(() => this.testConnection());
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

  private showLogin(container: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(container).setName("Log in").setHeading();

    new Setting(container).setName("Username").addText((text) => {
      text.setValue(this.loginUsername).onChange((value) => {
        this.loginUsername = value.trim();
      });
    });
    new Setting(container).setName("Password").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(this.loginPassword).onChange((value) => {
        this.loginPassword = value;
      });
    });
    new Setting(container)
      .setName("Device name")
      .setDesc("Shown on the server and in conflict file names.")
      .addText((text) => {
        text.setValue(settings.deviceName).onChange(async (value) => {
          settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        });
      });
    new Setting(container).addButton((button) => {
      button
        .setButtonText("Log in")
        .setCta()
        .onClick(() => this.login());
    });
  }

  private async login(): Promise<void> {
    const settings = this.plugin.settings;
    if (!settings.serverUrl || !this.loginUsername || !this.loginPassword) {
      notify("Fill in server URL, username and password");
      return;
    }
    const client = new VaultClient({ baseUrl: settings.serverUrl, http: obsidianHttp });
    try {
      const result = await client.login(this.loginUsername, this.loginPassword, settings.deviceName);
      this.loginPassword = "";
      await this.plugin.onLoggedIn(result.token, result.tokenId, result.username);
      notify(`Logged in as ${result.username}. Syncing…`);
    } catch (error) {
      notify(`Login failed: ${errorMessage(error)}`);
    }
    this.display();
  }

  private showAccount(container: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(container)
      .setName("Account")
      .setDesc(`Logged in as ${settings.username} on "${settings.deviceName}". ${this.plugin.statusText}`)
      .addButton((button) => {
        button.setButtonText("Sync now").onClick(() => this.plugin.syncNow(true));
      })
      .addButton((button) => {
        button
          .setButtonText("Log out")
          .setWarning()
          .onClick(async () => {
            await this.plugin.logout();
            this.display();
          });
      });
  }

  private showSyncOptions(container: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(container).setName("Sync").setHeading();

    new Setting(container)
      .setName("Sync automatically")
      .setDesc("Sync shortly after every change, and whenever the server reports one.")
      .addToggle((toggle) => {
        toggle.setValue(settings.autoSync).onChange(async (value) => {
          settings.autoSync = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(container)
      .setName("Sync settings folder")
      .setDesc(
        `Also sync ${this.app.vault.configDir}: settings, themes, snippets, hotkeys and plugins. ` +
          "Window layout and this plugin's login always stay on this device.",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.syncConfig).onChange(async (value) => {
          settings.syncConfig = value;
          await this.plugin.saveSettings({ filterChanged: true });
        });
      });

    new Setting(container)
      .setName("Exclude")
      .setDesc('One pattern per line, e.g. "Private/" or "*.mp4".')
      .addTextArea((area) => {
        area.setValue(settings.excludes);
        area.inputEl.rows = 4;
        area.onChange(async (value) => {
          settings.excludes = value;
          await this.plugin.saveSettings({ filterChanged: true });
        });
      });

    new Setting(container)
      .setName("Check every (seconds)")
      .setDesc("Fallback when the live connection is down.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(settings.pollSeconds)).onChange(async (value) => {
          const seconds = Number(value);
          if (seconds >= 10) {
            settings.pollSeconds = seconds;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(container)
      .setName("Full resync")
      .setDesc(
        "Re-check every file against the server. Nothing is deleted; differences become conflict copies.",
      )
      .addButton((button) => {
        button.setButtonText("Resync").onClick(() => this.plugin.fullResync());
      });
  }
}
