import { Plugin, Notice, TFile, type TAbstractFile } from "obsidian";
import { SyncEngine } from "./sync/SyncEngine";
import { SinkSettingsTab } from "./ui/SettingsTab";
import { StatusBar, RibbonIcon } from "./ui/StatusBar";
import { FloatingStatus } from "./ui/FloatingStatus";
import { SetupWizard } from "./ui/SetupWizard";
import { ConflictModal } from "./ui/ConflictModal";
import { parseSetupURI, applySetupPayload } from "./utils/uri";
import { DEFAULT_SETTINGS, type SinkSettings, type SyncStatus } from "./settings";

export default class SinkPlugin extends Plugin {
  settings: SinkSettings = DEFAULT_SETTINGS;
  private syncEngine: SyncEngine | null = null;
  private statusBar: StatusBar | null = null;
  private ribbonIcon: RibbonIcon | null = null;
  private floatingStatus: FloatingStatus | null = null;

  async onload() {
    await this.loadSettings();

    // Add settings tab
    this.addSettingTab(new SinkSettingsTab(this.app, this));

    // Add status bar
    this.statusBar = new StatusBar(this.addStatusBarItem());

    // Add ribbon icon (left sidebar)
    const ribbonEl = this.addRibbonIcon("refresh-cw", "Sink", async () => {
      if (this.syncEngine) {
        new Notice("Sink: Syncing now...");
        try {
          await this.syncEngine.pullServerToVault();
          new Notice("Sink: Done");
        } catch (e: any) {
          new Notice(`Sink: Sync failed — ${e.message}`);
        }
      } else {
        new SetupWizard(this.app, this, "fresh").open();
      }
    });
    this.ribbonIcon = new RibbonIcon(ribbonEl);

    // Register URI handler for setup
    this.registerObsidianProtocolHandler("sink-setup", (params) => {
      const uri = `obsidian://sink-setup?${new URLSearchParams(params).toString()}`;
      const payload = parseSetupURI(uri);
      if (payload) {
        this.settings = applySetupPayload(this.settings, payload);
        this.saveSettings();
        new Notice("Sink: Settings imported from setup URI!");
        // Show setup wizard to complete (choose push/pull/merge)
        new SetupWizard(this.app, this, "imported").open();
      } else {
        new Notice("Sink: Invalid setup URI");
      }
    });

    // Floating status overlay — inject once workspace is ready
    this.app.workspace.onLayoutReady(() => {
      const workspaceEl = this.app.workspace.containerEl;
      this.floatingStatus = new FloatingStatus(workspaceEl);
    });

    // If configured, start syncing
    if (this.settings.isConfigured) {
      await this.startSync();
    } else {
      // Show setup wizard on first run
      this.app.workspace.onLayoutReady(() => {
        new SetupWizard(this.app, this, "fresh").open();
      });
    }

    // Add command palette commands
    this.addCommand({
      id: "sink-force-sync",
      name: "Force sync now",
      callback: async () => {
        if (this.syncEngine) {
          new Notice("Sink: Forcing sync...");
          try {
            await this.syncEngine.pullServerToVault();
            new Notice("Sink: Sync complete");
          } catch (e: any) {
            new Notice(`Sink: Sync failed — ${e.message}`);
          }
        }
      },
    });

    this.addCommand({
      id: "sink-show-status",
      name: "Show sync status",
      callback: () => {
        const status = this.syncEngine?.getStatus() || "disconnected";
        new Notice(`Sink status: ${status}`);
      },
    });
  }

  async onunload() {
    this.floatingStatus?.destroy();
    await this.stopSync();
  }

  /** Start the sync engine and register vault event listeners */
  async startSync(): Promise<void> {
    if (this.syncEngine) {
      await this.syncEngine.stop();
    }

    // Default device name to a generated one
    if (!this.settings.deviceName) {
      this.settings.deviceName = `device-${Date.now().toString(36)}`;
    }

    this.syncEngine = new SyncEngine(
      this.app,
      this.app.vault,
      this.settings,
      this.app.vault.getName(),
      (event) => this.handleSyncEvent(event)
    );

    try {
      const identityChanged = await this.syncEngine.initializeDeviceIdentity();
      if (identityChanged) {
        await this.saveSettings();
      }

      await this.syncEngine.start();
      await this.refreshRibbonState();
      this.statusBar?.setStatus("connected");

      // Register vault events
      this.registerEvent(
        this.app.vault.on("modify", (file: TAbstractFile) => {
          if (file instanceof TFile) {
            this.syncEngine?.onFileChange(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on("create", (file: TAbstractFile) => {
          if (file instanceof TFile) {
            this.syncEngine?.onFileChange(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on("delete", (file: TAbstractFile) => {
          this.syncEngine?.onFileDelete(file);
        })
      );

      this.registerEvent(
        this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
          this.syncEngine?.onFileRename(file, oldPath);
        })
      );
    } catch (e: any) {
      this.statusBar?.setStatus("error");
      new Notice(`Sink: Failed to start — ${e.message}`);
    }
  }

  /** Stop the sync engine */
  async stopSync(): Promise<void> {
    if (this.syncEngine) {
      await this.syncEngine.stop();
      this.syncEngine = null;
    }
    this.statusBar?.setStatus("disconnected");
  }

  /** Handle events from the sync engine */
  private handleSyncEvent(event: any): void {
    switch (event.type) {
      case "status-change":
        this.statusBar?.setStatus(event.status as SyncStatus);
        void this.refreshRibbonState(event.status as SyncStatus);
        this.floatingStatus?.setStatus(event.status as SyncStatus);
        break;
      case "doc-pushed":
        this.statusBar?.setActiveFile(event.path, "push");
        this.floatingStatus?.showActivity(event.path, "push");
        break;
      case "doc-pulled":
        this.statusBar?.setActiveFile(event.path, "pull");
        this.floatingStatus?.showActivity(event.path, "pull");
        break;
      case "error":
        console.error("Sink sync error:", event.message);
        if (event.message.includes("401") || event.message.includes("403") || event.message.includes("locked") || event.message.includes("forbidden")) {
          new Notice("Sink: Authentication failed — check your username and password in settings.");
        }
        break;
      case "conflict":
        if (!this.settings.autoResolveConflicts) {
          new ConflictModal(this.app, event.path, "", "").open();
        }
        break;
    }
  }

  async refreshRibbonState(status?: SyncStatus): Promise<void> {
    if (!this.ribbonIcon) return;

    const engine = this.syncEngine;
    if (!engine) {
      this.ribbonIcon.update(status ?? "disconnected");
      return;
    }

    const [role, headState] = await Promise.all([engine.getCurrentDeviceRole(), Promise.resolve(engine.getSyncHeadState())]);
    this.ribbonIcon.update(status ?? engine.getStatus(), role, headState);
  }

  /** Get the sync engine (for UI components) */
  getSyncEngine(): SyncEngine | null {
    return this.syncEngine;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.syncEngine) {
      this.syncEngine.updateSettings(this.settings);
    }
  }
}
