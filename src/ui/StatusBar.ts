import type { SyncStatus } from "../settings";
import { setTooltip } from "obsidian";

export class StatusBar {
  private el: HTMLElement;
  private status: SyncStatus = "disconnected";

  constructor(statusBarEl: HTMLElement) {
    this.el = statusBarEl;
    this.el.addClass("sink-statusbar");
    this.render();
  }

  setStatus(status: SyncStatus): void {
    this.status = status;
    this.render();
  }

  // No-op — file activity is shown in the floating overlay instead
  setActiveFile(_path: string, _direction: "push" | "pull"): void {}

  private render(): void {
    const labels: Record<SyncStatus, string> = {
      connected:    "Sink",
      syncing:      "Sink ↑↓",
      error:        "Sink ✗",
      paused:       "Sink ⏸",
      disconnected: "Sink ○",
    };
    const tooltips: Record<SyncStatus, string> = {
      connected:    "Sink: Live sync active",
      syncing:      "Sink: Syncing changes",
      error:        "Sink: Sync error, check credentials",
      paused:       "Sink: Sync paused",
      disconnected: "Sink: Not connected to server",
    };
    const text = labels[this.status] ?? "Sink";
    const tip  = tooltips[this.status] ?? "Sink";
    this.el.setText(text);
    setTooltip(this.el, tip, { placement: "top" });
  }
}

export class RibbonIcon {
  private el: HTMLElement;
  private status: SyncStatus = "disconnected";

  constructor(ribbonEl: HTMLElement) {
    this.el = ribbonEl;
    this.update("disconnected");
  }

  update(status: SyncStatus): void {
    this.status = status;
    this.el.removeClass(
      "sink-ribbon-connected",
      "sink-ribbon-syncing",
      "sink-ribbon-error",
      "sink-ribbon-disconnected"
    );

    switch (status) {
      case "connected":
        this.el.addClass("sink-ribbon-connected");
        this.el.setAttribute("aria-label", "Sink — connected");
        break;
      case "syncing":
        this.el.addClass("sink-ribbon-syncing");
        this.el.setAttribute("aria-label", "Sink — syncing");
        break;
      case "error":
        this.el.addClass("sink-ribbon-error");
        this.el.setAttribute("aria-label", "Sink — error (click to retry)");
        break;
      default:
        this.el.addClass("sink-ribbon-disconnected");
        this.el.setAttribute("aria-label", "Sink — disconnected");
    }
  }
}
