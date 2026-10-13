import { App, Modal, Setting } from "obsidian";

interface ReleaseNote {
  version: string;
  title: string;
  points: string[];
}

const LATEST_RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.2.14",
    title: "Sync Stability and Editor-Style Diffs",
    points: [
      "New side-by-side diff viewer with aligned lines, inline highlights, synchronized scrolling, collapsed context, and change navigation.",
      "Fixed duplicate vault listeners after restarts; serialized sync work and improved shutdown cleanup and error handling.",
      "Incoming changes now respect config-sync settings. Workspace state, plugin-enable lists, and Sink's own directory are always excluded.",
      "Fixed chunked-text review/merge, fail-closed decryption, and publishing file chunks before their parent documents.",
      "Reduced database query and preview memory pressure. Files have a 20 MiB safety limit and snapshots a 32 MiB estimated memory budget.",
      "Config sync defaults off for new setups; existing saved settings are unchanged. Grey-screen crash causality remains unconfirmed—test with backups before enabling Sink in a live vault.",
    ],
  },
  {
    version: "0.2.13",
    title: "Encrypted Chunk Sync Reliability Fixes",
    points: [
      "Fixed encrypted large-file pull path so chunk decryption works after parent-doc preparation.",
      "Aligned chunk persistence behavior between normal push and 409 retry paths.",
      "Improved chunk reassembly fallback handling for mixed encrypted/plain chunk states.",
    ],
  },
  {
    version: "0.2.11",
    title: "Diff and Settings UI Polish",
    points: [
      "Wider review and diff windows for large change sets.",
      "Improved wrapping and pane overflow handling in split diff views.",
      "Cleaner settings layout and streamlined visual styling.",
    ],
  },
  {
    version: "0.2.10",
    title: "Device Role and Compatibility Controls",
    points: [
      "Role selector now reflects true current-device role from registry.",
      "Version gate prevents merge or upload when secondary differs from primary version.",
      "Pull activity shows source device details in the floating status.",
    ],
  },
  {
    version: "0.2.9",
    title: "Stable Device Identity",
    points: [
      "Incoming change filtering now uses stable device UUIDs.",
      "Reduced duplicate-device behavior after updates.",
    ],
  },
];

export class UpdateNotesModal extends Modal {
  private readonly previousVersion: string;
  private readonly currentVersion: string;

  constructor(app: App, previousVersion: string, currentVersion: string) {
    super(app);
    this.previousVersion = previousVersion;
    this.currentVersion = currentVersion;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sink-update-notes-modal");

    const firstInstall = !this.previousVersion;
    contentEl.createEl("h2", {
      text: firstInstall ? "Welcome to Sink" : `Sink updated to ${this.currentVersion}`,
    });

    if (firstInstall) {
      contentEl.createEl("p", {
        text: "You are on the latest Sink build. Here is what is currently included:",
        cls: "setting-item-description",
      });
    } else {
      contentEl.createEl("p", {
        text: `Previous version: ${this.previousVersion}`,
        cls: "setting-item-description",
      });
    }

    const latest = this.selectLatestNote(this.currentVersion);
    contentEl.createEl("h3", { text: `${latest.version} - ${latest.title}` });

    const list = contentEl.createEl("ul", { cls: "sink-update-notes-list" });
    for (const point of latest.points) {
      list.createEl("li", { text: point });
    }

    const previousNotes = contentEl.createEl("details", { cls: "sink-update-notes-history" });
    previousNotes.createEl("summary", { text: "See recent updates" });
    for (const note of LATEST_RELEASE_NOTES) {
      const block = previousNotes.createDiv({ cls: "sink-update-note-block" });
      block.createEl("h4", { text: `${note.version} - ${note.title}` });
      const items = block.createEl("ul");
      for (const point of note.points) {
        items.createEl("li", { text: point });
      }
    }

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Got it")
        .setCta()
        .onClick(() => this.close())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private selectLatestNote(version: string): ReleaseNote {
    const exact = LATEST_RELEASE_NOTES.find((entry) => entry.version === version);
    if (exact) return exact;
    return LATEST_RELEASE_NOTES[0];
  }
}
