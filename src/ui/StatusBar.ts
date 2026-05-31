import type { SyncStatus } from "../settings";

export class StatusBar {
  private el: HTMLElement;
  private status: SyncStatus = "disconnected";

  constructor(statusBarEl: HTMLElement) {
    this.el = statusBarEl;
    this.render();
  }

  setStatus(status: SyncStatus): void {
    this.status = status;
    this.render();
  }

  private render(): void {
    this.el.empty();
    this.el.removeClass("sink-status-syncing", "sink-status-error", "sink-status-connected");

    const icon = this.getIcon();
    const label = this.getLabel();

    this.el.setText(`${icon} ${label}`);

    switch (this.status) {
      case "syncing":
        this.el.addClass("sink-status-syncing");
        break;
      case "error":
        this.el.addClass("sink-status-error");
        break;
      case "connected":
        this.el.addClass("sink-status-connected");
        break;
    }

    this.el.setAttribute("aria-label", `Sink: ${label}`);
  }

  private getIcon(): string {
    switch (this.status) {
      case "connected": return "●";
      case "syncing": return "↻";
      case "error": return "✖";
      case "paused": return "⏸";
      case "disconnected": return "○";
      default: return "○";
    }
  }

  private getLabel(): string {
    switch (this.status) {
      case "connected": return "Sink";
      case "syncing": return "Syncing...";
      case "error": return "Sink (error)";
      case "paused": return "Sink (paused)";
      case "disconnected": return "Sink (off)";
      default: return "Sink";
    }
  }
}
