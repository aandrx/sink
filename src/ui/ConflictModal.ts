import { App, Modal, Setting } from "obsidian";

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
    const { contentEl } = this;
    contentEl.addClass("sink-conflict-modal");

    contentEl.createEl("h2", { text: "Sync Conflict" });
    contentEl.createEl("p", { text: `File: ${this.path}` });
    contentEl.createEl("p", {
      text: "This file was edited on multiple devices. Choose which version to keep:",
      cls: "setting-item-description",
    });

    // Diff display
    if (this.mine && this.theirs) {
      const diffContainer = contentEl.createDiv({ cls: "sink-diff-container" });

      const mineDiv = diffContainer.createDiv({ cls: "sink-diff-side" });
      mineDiv.createEl("h4", { text: "This device" });
      mineDiv.createEl("pre", { text: this.truncate(this.mine, 2000) });

      const theirsDiv = diffContainer.createDiv({ cls: "sink-diff-side" });
      theirsDiv.createEl("h4", { text: "Other device" });
      theirsDiv.createEl("pre", { text: this.truncate(this.theirs, 2000) });
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

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "\n... (truncated)";
  }
}
