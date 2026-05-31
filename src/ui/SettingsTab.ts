import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type SinkPlugin from "../SinkPlugin";
import { generateSetupURI } from "../utils/uri";
import { SetupWizard } from "./SetupWizard";

export class SinkSettingsTab extends PluginSettingTab {
  plugin: SinkPlugin;

  constructor(app: App, plugin: SinkPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h1", { text: "Sink" });
    containerEl.createEl("p", {
      text: "Always-on vault sync via self-hosted CouchDB.",
      cls: "setting-item-description",
    });

    // --- Connection Section ---
    containerEl.createEl("h2", { text: "Connection" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("CouchDB address (e.g., http://100.64.0.1:5984)")
      .addText((text) =>
        text
          .setPlaceholder("http://your-server:5984")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Username")
      .addText((text) =>
        text
          .setPlaceholder("admin")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Password")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("password")
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Database name")
      .setDesc("Name of the CouchDB database to sync with")
      .addText((text) =>
        text
          .setPlaceholder("sink")
          .setValue(this.plugin.settings.dbName)
          .onChange(async (value) => {
            this.plugin.settings.dbName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the server is reachable and credentials work")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          const engine = this.plugin.getSyncEngine();
          if (engine) {
            const result = await engine.testConnection();
            new Notice(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
          } else {
            // Create a temporary engine to test
            const { RemoteDB } = await import("../sync/RemoteDB");
            const remote = new RemoteDB(this.plugin.settings);
            const result = await remote.testConnection();
            new Notice(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
          }
        })
      );

    // --- Security Section ---
    containerEl.createEl("h2", { text: "Security" });

    new Setting(containerEl)
      .setName("Encryption passphrase")
      .setDesc("Encrypts all content before storing in CouchDB. All devices must use the same passphrase.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("leave empty to disable")
          .setValue(this.plugin.settings.passphrase)
          .onChange(async (value) => {
            this.plugin.settings.passphrase = value;
            await this.plugin.saveSettings();
          });
      });

    // --- Sync Behavior Section ---
    containerEl.createEl("h2", { text: "Sync Behavior" });

    new Setting(containerEl)
      .setName("Sync delay")
      .setDesc("Milliseconds to wait after last edit before syncing (lower = faster, more traffic)")
      .addSlider((slider) =>
        slider
          .setLimits(200, 5000, 100)
          .setValue(this.plugin.settings.syncDelay)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncDelay = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-resolve conflicts")
      .setDesc("Automatically merge conflicting edits. Disable to be prompted for manual resolution.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoResolveConflicts)
          .onChange(async (value) => {
            this.plugin.settings.autoResolveConflicts = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync config folder")
      .setDesc("Sync .obsidian/ folder (plugins, themes, snippets) between devices")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncConfigFolder)
          .onChange(async (value) => {
            this.plugin.settings.syncConfigFolder = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Device Section ---
    containerEl.createEl("h2", { text: "Device" });

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Friendly name for this device (used to identify sync source)")
      .addText((text) =>
        text
          .setPlaceholder("my-laptop")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Actions Section ---
    containerEl.createEl("h2", { text: "Actions" });

    new Setting(containerEl)
      .setName("Generate setup URI")
      .setDesc("Copy a URI to quickly set up Sink on another device")
      .addButton((btn) =>
        btn.setButtonText("Copy URI").onClick(async () => {
          const uri = await generateSetupURI(this.plugin.settings);
          await navigator.clipboard.writeText(uri);
          new Notice("Setup URI copied to clipboard!");
        })
      );

    new Setting(containerEl)
      .setName("Run setup wizard")
      .setDesc("Re-run the initial setup (push/pull/merge options)")
      .addButton((btn) =>
        btn.setButtonText("Setup").onClick(() => {
          new SetupWizard(this.app, this.plugin, "manual").open();
        })
      );

    new Setting(containerEl)
      .setName("Rebuild local database")
      .setDesc("Destroy and recreate the local sync database. Use if sync is broken.")
      .addButton((btn) =>
        btn.setButtonText("Rebuild").setWarning().onClick(async () => {
          const engine = this.plugin.getSyncEngine();
          if (engine) {
            await engine.destroyLocalDB();
            new Notice("Local database destroyed. Restarting sync...");
            await this.plugin.startSync();
          }
        })
      );
  }
}
