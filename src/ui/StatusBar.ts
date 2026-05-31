import type { SyncStatus } from "../settings";

export class StatusBar {
  private el: HTMLElement;
  private status: SyncStatus = "disconnected";
  private lastFile: string | null = null;
  private clearFileTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(statusBarEl: HTMLElement) {
    this.el = statusBarEl;
    this.el.addClass("sink-statusbar");
    this.render();
  }

  setStatus(status: SyncStatus): void {
    this.status = status;
    this.render();
  }

  setActiveFile(path: string, direction: "push" | "pull"): void {
    // Show just the filename, not the full path
    const filename = path.split("/").pop() ?? path;
    this.lastFile = `${direction === "push" ? "↑" : "↓"} ${filename}`;

    if (this.clearFileTimer) clearTimeout(this.clearFileTimer);
    this.clearFileTimer = setTimeout(() => {
      this.lastFile = null;
      this.render();
    }, 3000);

    this.render();
  }

  private render(): void {
    this.el.empty();
    this.el.removeClass("sink-status-syncing", "sink-status-error", "sink-status-connected");

    const icon = this.getIcon();
    const label = this.getLabel();
    const fileHint = this.lastFile ? ` · ${this.lastFile}` : "";

    this.el.setText(`${icon} ${label}${fileHint}`);

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
      case "connected":    return "●";
      case "syncing":      return "↻";
      case "error":        return "✖";
      case "paused":       return "⏸";
      case "disconnected": return "○";
      default:             return "○";
    }
  }

  private getLabel(): string {
    switch (this.status) {
      case "connected":    return "Sink";
      case "syncing":      return "Syncing";
      case "error":        return "Sink (error)";
      case "paused":       return "Sink (paused)";
      case "disconnected": return "Sink (off)";
      default:             return "Sink";
    }
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
