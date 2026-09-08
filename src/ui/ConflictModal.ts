import { App, Modal, Setting } from "obsidian";
import { renderSplitDiff } from "./DiffView";

export class ConflictModal extends Modal {
  private path: string;
  private mine: string;
  private theirs: string;
  private onResolve?: (choice: "mine" | "theirs") => void;

  constructor(app: App, path: string, mine: string, theirs: string, onResolve?: (choice: "mine" | "theirs") => void) {
    super(app);
    this.path = path;
    this.mine = mine;
    this.theirs = theirs;
    this.onResolve = onResolve;
  }

  onOpen() {
    this.modalEl.addClass("mod-sink-wide");
    const { contentEl } = this;
    contentEl.addClass("sink-conflict-modal");

    contentEl.createEl("h2", { text: "Sync Conflict" });
    contentEl.createEl("p", { text: `File: ${this.path}` });
    contentEl.createEl("p", {
      text: "This file was edited on multiple devices. Choose which version to keep:",
      cls: "setting-item-description",
    });

    if (this.mine || this.theirs) {
      renderSplitDiff(contentEl, "This device", "Other device", this.mine, this.theirs);
    }

    // Actions
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Keep mine").onClick(() => {
          this.onResolve?.("mine");
          this.close();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Keep theirs").onClick(() => {
          this.onResolve?.("theirs");
          this.close();
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }

}
