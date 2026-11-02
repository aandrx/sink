import type { SyncStatus } from "../settings";

/**
 * Decorative floating status overlay aligned with the top-right action icons.
 * Shows idle label at rest, updates to activity text on push/pull,
 * then reverts to idle after a delay.
 *
 * The overlay is aria-hidden: the status bar is the accessible surface.
 */
export class FloatingStatus {
  private el: HTMLElement;
  private textEl: HTMLElement;
  private detailEl: HTMLElement;
  private status: SyncStatus = "disconnected";
  private revertTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceEl: HTMLElement) {
    this.el = workspaceEl.createDiv({ cls: "sink-floating-status" });
    this.el.setAttribute("aria-hidden", "true");
    // Child div matches obsidian-livesync pattern: inner div gets opacity+grayscale from CSS
    this.textEl = this.el.createDiv();
    this.detailEl = this.el.createDiv({ cls: "sink-floating-status-detail" });
    this.renderIdle();
  }

  setStatus(status: SyncStatus): void {
    this.status = status;
    // A blocked/disconnected/review state must interrupt stale file activity.
    if (status !== "connected" && status !== "syncing" && this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    if (!this.revertTimer) {
      this.renderIdle();
    }
  }

  showActivity(path: string, direction: "push" | "pull", sourceDevice?: string): void {
    const filename = path.split("/").pop() ?? path;
    const verb = direction === "push" ? "Sending" : "Receiving";
    this.textEl.setText(`${verb} ${filename}`);
    this.detailEl.setText(direction === "pull" && sourceDevice ? `From ${sourceDevice}` : "");
    this.applyColor(direction === "push" ? "syncing" : "connected");

    // Reset any existing revert timer
    if (this.revertTimer) clearTimeout(this.revertTimer);
    this.revertTimer = setTimeout(() => {
      this.revertTimer = null;
      this.renderIdle();
    }, 4000);
  }

  private renderIdle(): void {
    const labels: Record<SyncStatus, string> = {
      connected:    "Connected",
      syncing:      "Syncing",
      error:        "Blocked",
      paused:       "Review",
      disconnected: "Disconnected",
    };
    this.textEl.setText(labels[this.status] ?? "Sink");
    this.detailEl.setText("");
    this.applyColor(this.status);
  }

  private applyColor(status: SyncStatus): void {
    this.textEl.removeClass(
      "sink-floating-connected",
      "sink-floating-syncing",
      "sink-floating-error",
      "sink-floating-paused",
      "sink-floating-disconnected"
    );
    switch (status) {
      case "connected": this.textEl.addClass("sink-floating-connected"); break;
      case "syncing":   this.textEl.addClass("sink-floating-syncing");   break;
      case "error":     this.textEl.addClass("sink-floating-error");     break;
      case "paused":    this.textEl.addClass("sink-floating-paused");    break;
      default:          this.textEl.addClass("sink-floating-disconnected"); break;
    }
  }

  destroy(): void {
    if (this.revertTimer) clearTimeout(this.revertTimer);
    this.el.remove();
  }
}
