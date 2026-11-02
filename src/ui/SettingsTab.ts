import { App, DropdownComponent, Modal, PluginSettingTab, Setting, Notice, TFile } from "obsidian";
import type SinkPlugin from "../SinkPlugin";
import type { DeviceRole, KnownDevice, SnapshotFileEntry, SnapshotMetaDoc, SnapshotSummary } from "../settings";
import type { SyncEngine } from "../sync/SyncEngine";
import { renderSplitDiff } from "./DiffView";
import { generateSetupURI } from "../utils/uri";
import { SetupWizard } from "./SetupWizard";

export class SinkSettingsTab extends PluginSettingTab {
  plugin: SinkPlugin;
  private snapshotRenderGeneration = 0;
  private roleDropdown: DropdownComponent | null = null;
  private devicesContainer: HTMLElement | null = null;
  private devicesInfoEl: HTMLElement | null = null;

  constructor(app: App, plugin: SinkPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sink-settings-root");
    this.roleDropdown = null;

    containerEl.createEl("h1", { text: "Sink" });
    containerEl.createEl("p", {
      text: "Always-on vault sync via self-hosted CouchDB.",
      cls: "setting-item-description",
    });

    // --- Connection Section ---
    containerEl.createEl("h2", { text: "Connection" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("CouchDB address (e.g., http://100.64.0.1:5985)")
      .addText((text) =>
        text
          .setPlaceholder("http://your-server:5985")
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
      .setName("Connection settings")
      .setDesc("These fields save automatically. Restart sync with these settings to apply them to a running sync engine.")
      .addButton((btn) =>
        btn.setButtonText("Restart sync with these settings").setCta().onClick(async () => {
          await this.plugin.saveSettings();
          if (this.plugin.getSyncEngine() || this.plugin.settings.isConfigured) {
            new Notice("Sink: Restarting sync with these settings...");
            await this.plugin.startSync();
            if (this.plugin.getSyncEngine()) new Notice("Sink: Sync restarted with these settings");
          } else {
            new Notice("Sink: Connection settings saved. Sync is not running.");
          }
        })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the server is reachable and credentials work")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Testing...");
          try {
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
          } finally {
            btn.setDisabled(false);
            btn.setButtonText("Test");
          }
        })
      );

    // --- Security Section ---
    containerEl.createEl("h2", { text: "Security" });

    new Setting(containerEl)
      .setName("Encryption passphrase")
      .setDesc("Encrypts new file content and local snapshot payloads. Paths and device metadata remain visible. All devices must use the same passphrase; changing it does not re-encrypt existing data.")
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
      .setName("Auto-apply safe updates")
      .setDesc("Allow verified updates when this device has not edited the file. Divergent edits and deletions still require a side choice. Disable to review updates to existing files.")
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
      .setDesc("Allow config-folder sync. Keep off while diagnosing crashes. Workspace state, plugin-enable lists, and Sink itself are always excluded. Existing files on the server are not removed.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncConfigFolder)
          .onChange(async (value) => {
            this.plugin.settings.syncConfigFolder = value;
            await this.plugin.saveSettings();
          })
      );

    const engine = this.plugin.getSyncEngine();
    if (engine) {
      new Setting(containerEl)
        .setName("Session upload permission")
        .setDesc("Allow this device to publish for this session. This does not combine text or bypass conflict and deletion reviews. Permission ends when Sink stops or Obsidian closes.")
        .addButton((btn) =>
          btn
            .setButtonText(engine.isSessionMergeAllowed ? "Revoke session permission" : "Allow uploads for this session")
            .setCta()
            .onClick(async () => {
              const currentEngine = this.plugin.getSyncEngine();
              if (!currentEngine) return;

              if (currentEngine.isSessionMergeAllowed) {
                currentEngine.clearSessionMergeAllowance();
                new Notice("Session upload permission revoked");
              } else {
                currentEngine.allowMergesForSession();
                new Notice("Session uploads allowed; conflict and deletion reviews remain enabled");
              }
              this.display();
            })
        );
    }

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

    const roleEngine = this.plugin.getSyncEngine();
    const roleSetting = new Setting(containerEl)
      .setName("This device role")
      .setDesc(
        roleEngine
          ? "Primary devices can upload immediately. Secondary devices must confirm before uploading changes."
          : "Start sync on this device to change its role."
      );

    roleSetting.addDropdown((dropdown) => {
      this.roleDropdown = dropdown;
      dropdown
        .addOption("primary", "Primary")
        .addOption("secondary", "Secondary")
        .onChange(async (value) => {
          const engine = this.plugin.getSyncEngine();
          if (!engine || !this.plugin.settings.deviceId) return;

          await engine.setDeviceRole(this.plugin.settings.deviceId, value as DeviceRole);
          await this.plugin.refreshRibbonState();
          new Notice(`Device role set to ${this.formatRole(value as DeviceRole)}`);
          await this.refreshDeviceList();
        });

      if (!roleEngine) {
        dropdown.setDisabled(true);
        dropdown.selectEl.title = "Start sync on this device to change the role.";
      }

      void this.populateCurrentRole(dropdown);
    });

    containerEl.createEl("h2", { text: "Known Devices" });
    const devicesInfo = containerEl.createEl("p", {
      text: "Devices are tracked by synced registry docs. Primary devices are listed first.",
      cls: "setting-item-description",
    });
    const devicesContainer = containerEl.createDiv();
    this.devicesContainer = devicesContainer;
    this.devicesInfoEl = devicesInfo;

    new Setting(containerEl)
      .setName("Refresh device list")
      .setDesc("Pull the latest device registry from the server")
      .addButton((btn) =>
        btn.setButtonText("Refresh").onClick(async () => {
          await this.renderKnownDevices(devicesContainer, devicesInfo, true);
        })
      );

    void this.renderKnownDevices(devicesContainer, devicesInfo, false);

    containerEl.createEl("h2", { text: "Snapshots" });
    const backupInfo = containerEl.createEl("p", {
      text: "Select a snapshot to review its changed files, then select a file to inspect the diff.",
      cls: "setting-item-description",
    });
    const backupContainer = containerEl.createDiv();

    new Setting(containerEl)
      .setName("Refresh snapshots")
      .setDesc("Show recent snapshots")
      .addButton((btn) =>
        btn.setButtonText("Refresh").onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.renderSnapshots(backupContainer, backupInfo);
          } finally {
            btn.setDisabled(false);
          }
        })
      );

    void this.renderSnapshots(backupContainer, backupInfo);

    // --- Troubleshooting Section ---
    containerEl.createEl("h2", { text: "Troubleshooting" });
    const syncEngine = this.plugin.getSyncEngine();
    const syncStatus = syncEngine?.getStatus() ?? "disconnected";
    const syncHead = syncEngine?.getSyncHeadState() ?? "head";
    containerEl.createEl("p", {
      text: syncEngine
        ? `Status: ${syncStatus}. ${syncHead === "behind" ? "Pending work may need a decision." : "No known pending changes."}`
        : "Sync is not running. Start it to review pending work.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Resolve pending sync issues")
      .setDesc("Reopen the review for deferred changes, retained conflicts, or a blocked retry.")
      .addButton((btn) =>
        btn
          .setButtonText("Review issues")
          .setDisabled(!syncEngine)
          .onClick(() => void this.plugin.resolvePendingSync())
      );

    new Setting(containerEl)
      .setName("Restart sync")
      .setDesc("Stop and start the sync engine with the current settings. Use after a connection or review failure.")
      .addButton((btn) =>
        btn.setButtonText("Restart").onClick(async () => {
          await this.plugin.startSync();
          this.display();
        })
      );

    // --- Actions Section ---
    containerEl.createEl("h2", { text: "Actions" });

    new Setting(containerEl)
      .setName("Generate setup URI")
      .setDesc("Copy a URI to set up Sink on another device. The URI contains your password and encryption passphrase in readable form; store it securely.")
      .addButton((btn) =>
        btn.setButtonText("Copy URI").onClick(async () => {
          const uri = await generateSetupURI(this.plugin.settings);
          await navigator.clipboard.writeText(uri);
          new Notice("Setup URI copied. It contains your password and passphrase in readable form; store it securely.");
        })
      );

    new Setting(containerEl)
      .setName("Run setup wizard")
      .setDesc("Re-run the initial setup and choose a sync direction.")
      .addButton((btn) =>
        btn.setButtonText("Setup").onClick(() => {
          new SetupWizard(this.app, this.plugin, "manual").open();
        })
      );

    new Setting(containerEl)
      .setName("Rebuild local database")
      .setDesc("Destroy and recreate the local sync database. Use only if sync is broken. Back up the vault first; the local database cannot be recovered.")
      .addButton((btn) =>
        btn.setButtonText("Rebuild").setWarning().onClick(async () => {
          const engine = this.plugin.getSyncEngine();
          if (!engine) {
            new Notice("Sink: Start sync before rebuilding the local database.");
            return;
          }

          const ok = window.confirm(
            "Rebuild the local sync database? This destroys the local database and cannot be undone. Back up the vault before continuing."
          );
          if (!ok) return;

          await engine.destroyLocalDB();
          new Notice("Local database destroyed. Restarting sync...");
          await this.plugin.startSync();
        })
      );
  }

  private async refreshDeviceList(): Promise<void> {
    if (!this.devicesContainer || !this.devicesInfoEl) return;
    await this.renderKnownDevices(this.devicesContainer, this.devicesInfoEl, false);
    if (this.roleDropdown) await this.populateCurrentRole(this.roleDropdown);
  }

  private formatRole(role: DeviceRole): string {
    return role === "primary" ? "Primary" : "Secondary";
  }

  private async populateCurrentRole(dropdown: DropdownComponent): Promise<void> {
    const engine = this.plugin.getSyncEngine();
    if (!engine) return;

    const devices = await engine.refreshKnownDevices();
    const current = devices.find((device) => device.isCurrentDevice);
    dropdown.setValue(current?.role ?? (await engine.getCurrentDeviceRole()));
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
    const versionLabel = device.pluginVersion?.trim() ? `v${device.pluginVersion.trim()}` : "version unknown";
    const lastSeen = this.formatTimestamp(device.lastSeen);
    const lastPush = this.formatTimestamp(device.lastPushAt);
    const lastPull = this.formatTimestamp(device.lastPullAt);

    new Setting(container)
      .setName(`${device.deviceName} (${this.formatRole(device.role)})`)
      .setDesc(`${current} • ${versionLabel} • ${status} • last seen ${lastSeen} • last push ${lastPush} • last pull ${lastPull}`)
      .addButton((btn) =>
        btn
          .setButtonText("Primary")
          .setDisabled(device.role === "primary")
          .onClick(async () => {
            await engine.setDeviceRole(device.deviceId, "primary");
            if (device.isCurrentDevice) {
              await this.plugin.refreshRibbonState();
            }
            new Notice(`${device.deviceName} marked ${this.formatRole("primary")}`);
            await this.refreshDeviceList();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Secondary")
          .setDisabled(device.role === "secondary")
          .onClick(async () => {
            await engine.setDeviceRole(device.deviceId, "secondary");
            if (device.isCurrentDevice) {
              await this.plugin.refreshRibbonState();
            }
            new Notice(`${device.deviceName} marked ${this.formatRole("secondary")}`);
            await this.refreshDeviceList();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Remove")
          .setDisabled(device.isCurrentDevice)
          .setTooltip(
            device.isCurrentDevice
              ? "The current device cannot be removed from the known devices list."
              : "Remove this device from the known devices list."
          )
          .setWarning()
          .onClick(async () => {
            const ok = window.confirm(`Remove ${device.deviceName} from the known devices list?`);
            if (!ok) return;

            await engine.removeDevice(device.deviceId);
            new Notice(`${device.deviceName} removed`);
            this.display();
          })
      );
  }

  private async renderSnapshots(container: HTMLElement, infoEl: HTMLElement): Promise<void> {
    const renderGeneration = ++this.snapshotRenderGeneration;
    container.empty();
    const engine = this.plugin.getSyncEngine();
    if (!engine) {
      infoEl.setText("Start sync on this device to view snapshots.");
      return;
    }

    try {
      const snapshots = await engine.listSnapshots(15);
      if (renderGeneration !== this.snapshotRenderGeneration) return;
      if (snapshots.length === 0) {
        infoEl.setText("No snapshots found yet.");
        return;
      }

      infoEl.setText("Snapshots are local safety copies taken before risky batches are applied.");

      const selectorRow = container.createDiv({ cls: "sink-snapshot-selector-row" });
      const select = selectorRow.createEl("select", { cls: "sink-snapshot-select" });
      const restoreBtn = selectorRow.createEl("button", { text: "Restore snapshot" });

      const snapshotDetails = container.createDiv({ cls: "sink-snapshot-details" });
      const selectedSnapshot = snapshots[0];

      for (const snapshot of snapshots) {
        const option = select.createEl("option", {
          text: `${this.formatTimestamp(snapshot.createdAt)} • ${snapshot.reason}`,
        });
        option.value = snapshot.id;
      }
      select.value = selectedSnapshot.id;

      let selectionGeneration = 0;
      const renderSelected = async (snapshotId: string) => {
        const selection = ++selectionGeneration;
        const isCurrent = () => renderGeneration === this.snapshotRenderGeneration && selection === selectionGeneration;
        snapshotDetails.empty();
        try {
          const snapshot = await engine.getSnapshotDetails(snapshotId);
          if (!isCurrent()) return;
          if (!snapshot) {
            snapshotDetails.createEl("p", { text: "Snapshot not found." });
            return;
          }

          const ordered = await this.orderSnapshotFilesByChange(snapshot);
          if (!isCurrent()) return;

          snapshotDetails.empty();
          snapshotDetails.createEl("h3", { text: `${this.formatTimestamp(snapshot.createdAt)} • ${snapshot.reason}` });
          snapshotDetails.createEl("p", {
            text: `Source: ${snapshot.sourceDevice} • ${snapshot.files.length} files`,
            cls: "setting-item-description",
          });

          const fileList = snapshotDetails.createDiv({ cls: "sink-snapshot-file-list" });
          for (const fileEntry of ordered) {
            this.renderSnapshotFileRow(fileList, snapshot, fileEntry);
          }
        } catch (error) {
          if (!isCurrent()) return;
          snapshotDetails.empty();
          this.renderSnapshotError(snapshotDetails, error, "Could not load this snapshot");
        }
      };

      select.addEventListener("change", () => {
        void renderSelected(select.value);
      });

      restoreBtn.addEventListener("click", async () => {
        const snapshot = snapshots.find((entry) => entry.id === select.value) ?? snapshots[0];
        const ok = window.confirm(
          `Restore snapshot from ${this.formatTimestamp(snapshot.createdAt)} affecting ${snapshot.fileCount} files?`
        );
        if (!ok) return;

        restoreBtn.disabled = true;
        try {
          const restored = await engine.restoreSnapshot(snapshot.id);
          if (restored < snapshot.fileCount) {
            new Notice(
              `Sink: Restored ${restored} of ${snapshot.fileCount} snapshot files. Some files were skipped; review the vault before retrying.`
            );
          } else {
            new Notice(`Sink: Restored ${restored} files from snapshot`);
          }
        } catch (error) {
          const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
          const message = `Restore did not complete${detail}. Some files may already have been restored; review the vault before retrying.`;
          snapshotDetails.empty();
          snapshotDetails.createEl("p", { text: message, cls: "setting-item-description" });
          new Notice(`Sink: ${message}`);
        } finally {
          restoreBtn.disabled = false;
        }
      });

      void renderSelected(selectedSnapshot.id);
    } catch (error) {
      if (renderGeneration !== this.snapshotRenderGeneration) return;
      container.empty();
      infoEl.setText("Snapshots could not be loaded.");
      this.renderSnapshotError(container, error, "Could not load snapshots");
    }
  }

  private renderSnapshotError(container: HTMLElement, error: unknown, fallback: string): void {
    const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const message = detail ? `${fallback}: ${detail}` : fallback;
    const bounded = message.length > 300 ? `${message.slice(0, 300)}...` : message;
    container.createEl("p", { text: bounded, cls: "setting-item-description" });
    new Notice(`Sink: ${bounded}`);
  }

  private async orderSnapshotFilesByChange(snapshot: SnapshotMetaDoc): Promise<SnapshotFileEntry[]> {
    const scored: Array<{ entry: SnapshotFileEntry; changed: boolean }> = [];
    // Compare one file at a time so binary snapshots do not allocate every whole file concurrently.
    for (const entry of snapshot.files) {
      scored.push({ entry, changed: await this.hasSnapshotFileChanged(entry) });
    }

    return scored
      .sort((left, right) => Number(right.changed) - Number(left.changed) || left.entry.path.localeCompare(right.entry.path))
      .map((item) => item.entry);
  }

  private async hasSnapshotFileChanged(entry: SnapshotFileEntry): Promise<boolean> {
    const current = this.app.vault.getAbstractFileByPath(entry.path);
    if (!entry.existed) return !!current;
    if (!current) return true;

    if (entry.isBinary) {
      if (!(current instanceof TFile)) return true;
      const buffer = await this.app.vault.readBinary(current);
      return this.arrayBufferToBase64(buffer) !== entry.content;
    }

    if (!(current instanceof TFile)) return true;
    const text = await this.app.vault.read(current);
    return text !== entry.content;
  }

  private renderSnapshotFileRow(container: HTMLElement, snapshot: SnapshotMetaDoc, entry: SnapshotFileEntry): void {
    const row = container.createDiv({ cls: "sink-snapshot-file-row" });
    const title = row.createDiv({ cls: "sink-snapshot-file-title" });
    title.createEl("span", { text: entry.path });
    if (!entry.existed) {
      title.createEl("span", { text: "deleted", cls: "sink-snapshot-file-badge" });
    }

    const actions = row.createDiv({ cls: "sink-device-row-actions" });
    const viewDiffButton = actions.createEl("button", { text: "View diff", cls: "mod-cta" });
    viewDiffButton.addEventListener("click", () => {
      void this.showSnapshotDiff(snapshot, entry);
    });
  }

  private async showSnapshotDiff(snapshot: SnapshotMetaDoc, entry: SnapshotFileEntry): Promise<void> {
    try {
      const currentText = await this.getCurrentFileText(entry);
      const snapshotText = entry.content;

      const modal = new Modal(this.app);
      modal.onOpen = () => {
        modal.modalEl.addClass("mod-sink-wide");
        const { contentEl } = modal;
        contentEl.empty();
        contentEl.addClass("sink-conflict-modal");
        contentEl.createEl("h3", { text: entry.path });
        contentEl.createEl("p", { text: `Snapshot: ${this.formatTimestamp(snapshot.createdAt)} • ${snapshot.reason}` });

        if (entry.isBinary) {
          contentEl.createEl("p", { text: "Binary diff preview is not available for this file." });
          return;
        }

        renderSplitDiff(contentEl, "Current", "Snapshot", currentText, snapshotText);
      };

      modal.open();
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
      new Notice(`Sink: Could not open the snapshot diff${detail}`);
    }
  }

  private async getCurrentFileText(entry: SnapshotFileEntry): Promise<string> {
    const current = this.app.vault.getAbstractFileByPath(entry.path);
    if (!current || !(current instanceof TFile)) return "";
    if (entry.isBinary) {
      const buffer = await this.app.vault.readBinary(current);
      return this.arrayBufferToBase64(buffer);
    }
    return await this.app.vault.read(current);
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index++) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  private formatTimestamp(value?: number): string {
    if (!value) return "never";
    return new Date(value).toLocaleString();
  }
}
