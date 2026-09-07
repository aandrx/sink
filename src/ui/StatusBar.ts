import { setTooltip } from "obsidian";
import type { DeviceRole, SyncStatus } from "../settings";

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
  private role: DeviceRole = "primary";
  private headState: "head" | "behind" = "head";

  constructor(ribbonEl: HTMLElement) {
    this.el = ribbonEl;
    this.update("disconnected");
  }

  update(status: SyncStatus, role: DeviceRole = this.role, headState: "head" | "behind" = this.headState): void {
    this.status = status;
    this.role = role;
    this.headState = headState;
    this.el.removeClass(
      "sink-ribbon-connected",
      "sink-ribbon-syncing",
      "sink-ribbon-error",
      "sink-ribbon-disconnected"
    );

    switch (status) {
      case "connected":
        this.el.addClass("sink-ribbon-connected");
        this.setLabel(`Sink: Connected - ${this.formatRole(role)}${headState === "behind" ? " - Behind remote" : " - At HEAD"}`);
        break;
      case "syncing":
        this.el.addClass("sink-ribbon-syncing");
        this.setLabel(`Sink: Syncing - ${this.formatRole(role)}`);
        break;
      case "error":
        this.el.addClass("sink-ribbon-error");
        this.setLabel(`Sink: Error - ${this.formatRole(role)}`);
        break;
      default:
        this.el.addClass("sink-ribbon-disconnected");
        this.setLabel(`Sink: Disconnected - ${this.formatRole(role)}`);
    }
  }

  private formatRole(role: DeviceRole): string {
    return role === "primary" ? "Primary" : "Secondary";
  }

  private setLabel(label: string): void {
    this.el.setAttribute("aria-label", label);
    setTooltip(this.el, label, { placement: "top" });
  }
}
