// Login form. A form with several required fields belongs in a modal, not in the settings tab.
// The password is only kept while the modal is open; the server hands back a per-device token instead.

import { Modal, Setting, type App, type ButtonComponent } from "obsidian";
import { VaultClient, errorMessage } from "@mcp-vault/core";
import type VaultSyncPlugin from "./main.ts";
import { notify } from "./notify.ts";
import { obsidianHttp } from "./obsidian-http.ts";

export class LoginModal extends Modal {
  private plugin: VaultSyncPlugin;
  private username = "";
  private password = "";
  private deviceName: string;
  private busy = false;
  private loginButton: ButtonComponent | null = null;
  /** Closing the modal cancels the login: a response that arrives later is thrown away. */
  private closed = false;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app);
    this.plugin = plugin;
    this.deviceName = plugin.settings.deviceName;
  }

  onOpen(): void {
    this.setTitle("Log in");
    const { contentEl } = this;

    new Setting(contentEl).setName("Username").addText((text) => {
      text.onChange((value) => {
        this.username = value.trim();
      });
    });
    new Setting(contentEl).setName("Password").addText((text) => {
      text.inputEl.type = "password";
      text.onChange((value) => {
        this.password = value;
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          void this.submit();
        }
      });
    });
    new Setting(contentEl)
      .setName("Device name")
      .setDesc("Shown on the server and in conflict file names.")
      .addText((text) => {
        text.setValue(this.deviceName).onChange((value) => {
          this.deviceName = value.trim();
        });
      });
    new Setting(contentEl).addButton((button) => {
      this.loginButton = button;
      button
        .setButtonText("Log in")
        .setCta()
        .onClick(() => this.submit());
    });
  }

  onClose(): void {
    this.closed = true;
    this.password = "";
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    const settings = this.plugin.settings;
    if (!settings.serverUrl || !this.username || !this.password) {
      notify("Fill in server URL, username and password");
      return;
    }
    this.setBusy(true);
    const client = new VaultClient({ baseUrl: settings.serverUrl, http: obsidianHttp });
    try {
      const result = await client.login(this.username, this.password, this.deviceName);
      if (this.closed) {
        // The user gave up on this login. Don't leave an unused device token behind on the server.
        await logoutQuietly(client);
        return;
      }
      settings.deviceName = this.deviceName;
      await this.plugin.onLoggedIn(result.token, result.tokenId, result.username);
      notify(`Logged in as ${result.username}. Syncing…`);
      this.close();
    } catch (error) {
      notify(`Login failed: ${errorMessage(error)}`);
    }
    this.setBusy(false);
  }

  /** Shows that the request is running, so nobody closes the modal on a slow server and loses the login. */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (!this.loginButton) {
      return;
    }
    this.loginButton.setDisabled(busy);
    if (busy) {
      this.loginButton.setButtonText("Logging in…");
    } else {
      this.loginButton.setButtonText("Log in");
    }
  }
}

async function logoutQuietly(client: VaultClient): Promise<void> {
  try {
    await client.logout();
  } catch {
    // Server unreachable: the token stays listed there and can be revoked with `token revoke`.
  }
}
