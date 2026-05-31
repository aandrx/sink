import type { SyncStatus } from "../settings";

/**
 * Floating status overlay aligned with the top-right action icons.
 * Shows idle label at rest, updates to activity text on push/pull,
 * then reverts to idle after a delay.
 */
export class FloatingStatus {
  private el: HTMLElement;
  private textEl: HTMLElement;
  private status: SyncStatus = "disconnected";
  private revertTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceEl: HTMLElement) {
    this.el = workspaceEl.createDiv({ cls: "sink-floating-status" });
    // Child div matches obsidian-livesync pattern: inner div gets opacity+grayscale from CSS
    this.textEl = this.el.createDiv();
    this.renderIdle();
  }

  setStatus(status: SyncStatus): void {
    this.status = status;
    // Only update display text if not currently showing activity
    if (!this.revertTimer) {
      this.renderIdle();
    }
  }

  showActivity(path: string, direction: "push" | "pull"): void {
    const filename = path.split("/").pop() ?? path;
    const verb = direction === "push" ? "Draining" : "Filling";
    this.textEl.setText(`${verb}  ${filename}`);
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
      connected:    "Full",
      syncing:      "Flowing",
      error:        "Blocked",
      paused:       "Holding",
      disconnected: "Empty",
    };
    this.textEl.setText(labels[this.status] ?? "Sink");
    this.applyColor(this.status);
  }

  private applyColor(status: SyncStatus | "connected" | "syncing"): void {
    this.textEl.removeClass(
      "sink-floating-connected",
      "sink-floating-syncing",
      "sink-floating-error",
      "sink-floating-disconnected"
    );
    switch (status) {
      case "connected": this.textEl.addClass("sink-floating-connected"); break;
      case "syncing":   this.textEl.addClass("sink-floating-syncing");   break;
      case "error":     this.textEl.addClass("sink-floating-error");     break;
      default:          this.textEl.addClass("sink-floating-disconnected"); break;
    }
  }

  destroy(): void {
    if (this.revertTimer) clearTimeout(this.revertTimer);
    this.el.remove();
  }
}
