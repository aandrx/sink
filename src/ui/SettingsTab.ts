import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type SinkPlugin from "../SinkPlugin";
import type { DeviceRole, KnownDevice, SnapshotSummary } from "../settings";
import type { SyncEngine } from "../sync/SyncEngine";
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

    const roleSetting = new Setting(containerEl)
      .setName("This device role")
      .setDesc("Primary devices can upload immediately. Secondary devices must confirm before uploading changes.");

    roleSetting.addDropdown((dropdown) => {
      dropdown
        .addOption("primary", "Primary")
        .addOption("secondary", "Secondary")
        .setValue("primary")
        .onChange(async (value) => {
          const engine = this.plugin.getSyncEngine();
          if (!engine || !this.plugin.settings.deviceId) return;

          await engine.setDeviceRole(this.plugin.settings.deviceId, value as DeviceRole);
          new Notice(`Device role set to ${value}`);
          this.display();
        });

      void this.populateCurrentRole(dropdown);
    });

    containerEl.createEl("h2", { text: "Known Devices" });
    const devicesInfo = containerEl.createEl("p", {
      text: "Devices are tracked by synced registry docs. Primary devices are listed first.",
      cls: "setting-item-description",
    });
    const devicesContainer = containerEl.createDiv();

    new Setting(containerEl)
      .setName("Refresh device list")
      .setDesc("Pull the latest device registry from the server")
      .addButton((btn) =>
        btn.setButtonText("Refresh").onClick(async () => {
          await this.renderKnownDevices(devicesContainer, devicesInfo, true);
        })
      );

    void this.renderKnownDevices(devicesContainer, devicesInfo, false);

    containerEl.createEl("h2", { text: "Backups" });
    const backupInfo = containerEl.createEl("p", {
      text: "Risky sync batches now create restore points. Use these to roll back local files.",
      cls: "setting-item-description",
    });
    const backupContainer = containerEl.createDiv();

    new Setting(containerEl)
      .setName("Refresh snapshots")
      .setDesc("Show recent restore points")
      .addButton((btn) =>
        btn.setButtonText("Refresh").onClick(async () => {
          await this.renderSnapshots(backupContainer, backupInfo);
        })
      );

    void this.renderSnapshots(backupContainer, backupInfo);

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

  private async populateCurrentRole(dropdown: HTMLSelectElement): Promise<void> {
    const engine = this.plugin.getSyncEngine();
    if (!engine) return;

    const devices = await engine.getKnownDevices();
    const current = devices.find((device) => device.isCurrentDevice);
    if (current) {
      dropdown.value = current.role;
    }
  }

  private async renderKnownDevices(container: HTMLElement, infoEl: HTMLElement, refresh: boolean): Promise<void> {
    container.empty();
    const engine = this.plugin.getSyncEngine();

    if (!engine) {
      infoEl.setText("Start sync on this device to load and manage the registry.");
      return;
    }

    const devices = refresh ? await engine.refreshKnownDevices() : await engine.getKnownDevices();
    if (devices.length === 0) {
      infoEl.setText("No devices are registered yet. The current device will appear after its first heartbeat.");
      return;
    }

    infoEl.setText("Known devices are sorted by role, then by most recent activity.");
    devices.forEach((device) => this.renderDeviceRow(container, engine, device));
  }

  private renderDeviceRow(container: HTMLElement, engine: SyncEngine, device: KnownDevice): void {
    const status = device.isActive ? "active" : "stale";
    const current = device.isCurrentDevice ? "This device" : "Remote device";
    const lastSeen = this.formatTimestamp(device.lastSeen);
    const lastPush = this.formatTimestamp(device.lastPushAt);
    const lastPull = this.formatTimestamp(device.lastPullAt);

    new Setting(container)
      .setName(`${device.deviceName} (${device.role})`)
      .setDesc(`${current} • ${status} • last seen ${lastSeen} • last push ${lastPush} • last pull ${lastPull}`)
      .addButton((btn) =>
        btn
          .setButtonText("Make Primary")
          .setDisabled(device.role === "primary")
          .onClick(async () => {
            await engine.setDeviceRole(device.deviceId, "primary");
            new Notice(`${device.deviceName} marked primary`);
            this.display();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Make Secondary")
          .setDisabled(device.role === "secondary")
          .onClick(async () => {
            await engine.setDeviceRole(device.deviceId, "secondary");
            new Notice(`${device.deviceName} marked secondary`);
            this.display();
          })
      );
  }

  private async renderSnapshots(container: HTMLElement, infoEl: HTMLElement): Promise<void> {
    container.empty();
    const engine = this.plugin.getSyncEngine();
    if (!engine) {
      infoEl.setText("Start sync on this device to view restore points.");
      return;
    }

    const snapshots = await engine.listSnapshots(15);
    if (snapshots.length === 0) {
      infoEl.setText("No restore points found yet.");
      return;
    }

    infoEl.setText("Restore points are local safety snapshots taken before risky batches are applied.");
    snapshots.forEach((snapshot) => this.renderSnapshotRow(container, engine, snapshot));
  }

  private renderSnapshotRow(container: HTMLElement, engine: SyncEngine, snapshot: SnapshotSummary): void {
    new Setting(container)
      .setName(`${this.formatTimestamp(snapshot.createdAt)} (${snapshot.fileCount} files)`)
      .setDesc(snapshot.reason)
      .addButton((btn) =>
        btn.setButtonText("Restore").setWarning().onClick(async () => {
          const ok = window.confirm(
            `Restore snapshot from ${this.formatTimestamp(snapshot.createdAt)} affecting ${snapshot.fileCount} files?`
          );
          if (!ok) return;

          const restored = await engine.restoreSnapshot(snapshot.id);
          new Notice(`Sink: Restored ${restored} files from snapshot`);
        })
      );
  }

  private formatTimestamp(value?: number): string {
    if (!value) return "never";
    return new Date(value).toLocaleString();
  }
}
