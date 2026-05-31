import type { SyncStatus } from "../settings";

/**
 * Floating status overlay in the top-right corner of the editor,
 * similar to the display in obsidian-livesync.
 */
export class FloatingStatus {
  private el: HTMLElement;
  private messageEl: HTMLElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private status: SyncStatus = "disconnected";

  constructor(workspaceEl: HTMLElement) {
    this.el = workspaceEl.createDiv({ cls: "sink-floating-status" });
    this.messageEl = this.el.createDiv({ cls: "sink-floating-message" });
    this.render();
  }

  setStatus(status: SyncStatus): void {
    this.status = status;
    this.render();
  }

  showActivity(path: string, direction: "push" | "pull"): void {
    const filename = path.split("/").pop() ?? path;
    const dirLabel = direction === "push" ? "DB \u2191" : "DB \u2193";
    this.messageEl.setText(`${dirLabel}  ${filename}`);
    this.messageEl.removeClass("sink-floating-message-hidden");

    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.messageEl.addClass("sink-floating-message-hidden");
    }, 4000);
  }

  private render(): void {
    this.el.removeClass(
      "sink-floating-connected",
      "sink-floating-syncing",
      "sink-floating-error",
      "sink-floating-disconnected"
    );

    switch (this.status) {
      case "connected":
        this.el.addClass("sink-floating-connected");
        break;
      case "syncing":
        this.el.addClass("sink-floating-syncing");
        break;
      case "error":
        this.el.addClass("sink-floating-error");
        break;
      default:
        this.el.addClass("sink-floating-disconnected");
        break;
    }
  }

  destroy(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.el.remove();
  }
}
