import { App, Modal, Notice, Setting } from "obsidian";
import type SinkPlugin from "../SinkPlugin";
import { parseSetupURI, applySetupPayload } from "../utils/uri";
import { RemoteDB } from "../sync/RemoteDB";

type SetupMode = "fresh" | "imported" | "manual";

export class SetupWizard extends Modal {
  private plugin: SinkPlugin;
  private mode: SetupMode;
  private step: number = 1;
  private setupUri: string = "";

  constructor(app: App, plugin: SinkPlugin, mode: SetupMode) {
    super(app);
    this.plugin = plugin;
    this.mode = mode;

    // If imported, skip to step 2
    if (mode === "imported") {
      this.step = 2;
    }
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sink-setup-wizard");

    switch (this.step) {
      case 1:
        this.renderStep1();
        break;
      case 2:
        this.renderStep2();
        break;
      case 3:
        this.renderStep3();
        break;
    }
  }

  /** Step 1: Connection details or URI import */
  private renderStep1(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Sink Setup" });
    contentEl.createEl("p", { text: "Connect to your CouchDB server to start syncing." });

    // URI import option
    const uriSection = contentEl.createDiv({ cls: "sink-step" });
    uriSection.createEl("h3", { text: "Option A: Paste a Setup URI" });
    uriSection.createEl("p", {
      text: "If you have a setup URI from another device, paste it here.",
      cls: "setting-item-description",
    });

    new Setting(uriSection)
      .setName("Setup URI")
      .addText((text) =>
        text
          .setPlaceholder("obsidian://sink-setup?config=...")
          .onChange((value) => {
            this.setupUri = value;
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Import").onClick(() => {
          const payload = parseSetupURI(this.setupUri);
          if (payload) {
            this.plugin.settings = applySetupPayload(this.plugin.settings, payload);
            this.plugin.saveSettings();
            new Notice("Settings imported!");
            this.step = 2;
            this.render();
          } else {
            new Notice("Invalid setup URI");
          }
        })
      );

    // Manual option
    const manualSection = contentEl.createDiv({ cls: "sink-step" });
    manualSection.createEl("h3", { text: "Option B: Enter manually" });

    new Setting(manualSection)
      .setName("Server URL")
      .addText((text) =>
        text
          .setPlaceholder("http://100.64.0.1:5984")
          .setValue(this.plugin.settings.serverUrl)
          .onChange((value) => {
            this.plugin.settings.serverUrl = value.trim();
          })
      );

    new Setting(manualSection)
      .setName("Username")
      .addText((text) =>
        text
          .setPlaceholder("admin")
          .setValue(this.plugin.settings.username)
          .onChange((value) => {
            this.plugin.settings.username = value;
          })
      );

    new Setting(manualSection)
      .setName("Password")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("password")
          .setValue(this.plugin.settings.password)
          .onChange((value) => {
            this.plugin.settings.password = value;
          });
      });

    new Setting(manualSection)
      .setName("Database name")
      .addText((text) =>
        text
          .setPlaceholder("sink")
          .setValue(this.plugin.settings.dbName)
          .onChange((value) => {
            this.plugin.settings.dbName = value.trim();
          })
      );

    new Setting(manualSection)
      .setName("Encryption passphrase")
      .setDesc("Optional but recommended. All devices must use the same passphrase.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("leave empty to disable")
          .setValue(this.plugin.settings.passphrase)
          .onChange((value) => {
            this.plugin.settings.passphrase = value;
          });
      });

    // Test & Continue button
    new Setting(manualSection)
      .addButton((btn) =>
        btn
          .setButtonText("Test & Continue")
          .setCta()
          .onClick(async () => {
            await this.plugin.saveSettings();
            const remote = new RemoteDB(this.plugin.settings);
            const result = await remote.testConnection();
            if (result.success) {
              new Notice(`✓ ${result.message}`);
              this.step = 2;
              this.render();
            } else {
              new Notice(`✗ ${result.message}`);
            }
          })
      );
  }

  /** Step 2: Choose sync direction */
  private renderStep2(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Sync Direction" });
    contentEl.createEl("p", {
      text: "How should Sink handle the initial sync?",
    });

    const options = contentEl.createDiv({ cls: "sink-step" });

    new Setting(options)
      .setName("Push vault to server")
      .setDesc("Upload this vault's contents to the server. Use for the FIRST device.")
      .addButton((btn) =>
        btn.setButtonText("Push").onClick(async () => {
          this.step = 3;
          this.render();
          await this.performSync("push");
        })
      );

    new Setting(options)
      .setName("Pull from server")
      .setDesc("Download the server's contents to this vault. Use for ADDITIONAL devices with an empty vault.")
      .addButton((btn) =>
        btn.setButtonText("Pull").onClick(async () => {
          this.step = 3;
          this.render();
          await this.performSync("pull");
        })
      );

    new Setting(options)
      .setName("Merge")
      .setDesc("Sync both ways — keeps both local and server files. Use if this vault already has content.")
      .addButton((btn) =>
        btn.setButtonText("Merge").onClick(async () => {
          this.step = 3;
          this.render();
          await this.performSync("merge");
        })
      );

    // Back button
    if (this.mode !== "imported") {
      new Setting(options).addButton((btn) =>
        btn.setButtonText("← Back").onClick(() => {
          this.step = 1;
          this.render();
        })
      );
    }
  }

  /** Step 3: Progress / completion */
  private renderStep3(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Syncing..." });
    contentEl.createEl("p", { text: "Please wait while the initial sync completes." });
  }

  /** Perform the initial sync based on user choice */
  private async performSync(direction: "push" | "pull" | "merge"): Promise<void> {
    try {
      // Mark as configured and save
      this.plugin.settings.isConfigured = true;
      await this.plugin.saveSettings();

      // Start sync engine
      await this.plugin.startSync();

      const engine = this.plugin.getSyncEngine();
      if (!engine) throw new Error("Sync engine failed to start");

      let count = 0;
      switch (direction) {
        case "push":
          count = await engine.pushVaultToServer();
          new Notice(`Sink: Pushed ${count} files to server`);
          break;
        case "pull":
          count = await engine.pullServerToVault();
          new Notice(`Sink: Pulled ${count} files from server`);
          break;
        case "merge":
          // Push first, then pull (merge = bidirectional)
          count = await engine.pushVaultToServer();
          const pulled = await engine.pullServerToVault();
          new Notice(`Sink: Pushed ${count}, pulled ${pulled} files`);
          break;
      }

      // Update step 3 to show completion
      const { contentEl } = this;
      contentEl.empty();
      contentEl.createEl("h2", { text: "Setup Complete!" });
      contentEl.createEl("p", { text: "Sink is now syncing your vault. You can close this window." });
      contentEl.createEl("p", {
        text: "Tip: Use the 'Generate Setup URI' button in settings to set up additional devices.",
        cls: "setting-item-description",
      });

      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Done").setCta().onClick(() => this.close())
      );
    } catch (e: any) {
      const { contentEl } = this;
      contentEl.empty();
      contentEl.createEl("h2", { text: "Setup Failed" });
      contentEl.createEl("p", { text: `Error: ${e.message}` });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("← Back").onClick(() => {
          this.step = 1;
          this.render();
        })
      );
    }
  }
}
