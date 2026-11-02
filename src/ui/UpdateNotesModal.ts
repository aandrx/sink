import { App, Modal, Setting } from "obsidian";

interface ReleaseNote {
  version: string;
  title: string;
  points: string[];
}

const LATEST_RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.2.20",
    title: "UI Clarity and Safety",
    points: [
      "Status text now says Connected, Syncing, Review, Blocked, or Disconnected instead of Full, Flowing, Holding, or Empty.",
      "The review footer summarizes effective Local/Remote changes and confirms destructive deletions. Blocked rows are excluded from selection counts, and bulk skips are explained.",
      "The diff starts collapsed, file rows open on click, and keyboard focus is retained when expanding folded context.",
      "Settings, setup, and update-notes copy now explain credential exposure, destructive actions, partial failures, and snapshot terminology.",
    ],
  },
  {
    version: "0.2.19",
    title: "Stable Conflict Resolution",
    points: [
      "Pauses live replication during a retained-conflict review so the reviewed revision set cannot change while you decide.",
      "Allows deleted tombstone leaves to be ignored without blocking retirement.",
      "Resumes replication after the review is applied or cancelled.",
    ],
  },
  {
    version: "0.2.18",
    title: "Bounded Device History",
    points: [
      "Bounds local device metadata revisions and enables automatic PouchDB compaction, preventing oversized IndexedDB heartbeat records.",
      "Fixes the manual sync and status failure caused by an unreadable legacy device document.",
      "Existing oversized device history requires one local database rebuild. Back up the vault first; notes and the remote database are unchanged.",
    ],
  },
  {
    version: "0.2.17",
    title: "IndexedDB Teardown Fix",
    points: [
      "Stopped closing the shared IndexedDB connection during plugin shutdown. PouchDB keeps that connection for the replacement plugin instance.",
      "Shutdown still waits for an in-progress startup and drains queued sync work before the engine is released.",
      "0.2.16 and 0.2.15 features are unchanged.",
    ],
  },
  {
    version: "0.2.16",
    title: "IndexedDB Lifecycle Fix",
    points: [
      "Fixed the database connection closing error when Sink reloads or restarts during startup.",
      "Shutdown now waits for an in-progress start, and only the newest plugin instance closes the shared IndexedDB connection.",
      "0.2.15 features are unchanged: complete reviews, Local/Remote conflict resolution, startup reconciliation, and encrypted local snapshots.",
    ],
  },
  {
    version: "0.2.15",
    title: "Safer Sync and Complete Reviews",
    points: [
      "Review a complete pull in one workspace, with side-by-side diffs and explicit choices about which version to save.",
      "Cancelling ends the pull. Secondary-device uploads require permission before files change.",
      "Divergent edits require a side choice rather than an unsafe automatic merge; deletion review cannot be bypassed by session permission.",
      "New safety snapshots stay local and are encrypted when vault encryption is enabled. Previously replicated snapshots are not retroactively protected.",
      "Connection indicators reflect replication state. Keep using disposable-vault tests before a live rollout; grey-screen causality remains unconfirmed.",
    ],
  },
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

    const latest = this.findNote(this.currentVersion);
    if (firstInstall) {
      contentEl.createEl("p", {
        text: latest
          ? "You are on the latest Sink build. Here is what is currently included:"
          : "Welcome to Sink.",
        cls: "setting-item-description",
      });
    } else {
      contentEl.createEl("p", {
        text: `Previous version: ${this.previousVersion}`,
        cls: "setting-item-description",
      });
    }
    if (latest) {
      contentEl.createEl("h3", { text: `${latest.version} - ${latest.title}` });

      const list = contentEl.createEl("ul", { cls: "sink-update-notes-list" });
      for (const point of latest.points) {
        list.createEl("li", { text: point });
      }
    } else {
      contentEl.createEl("p", {
        text: `Release notes for ${this.currentVersion} are not available in this build.`,
        cls: "setting-item-description",
      });
    }

    const previousNotes = LATEST_RELEASE_NOTES.filter((note) => note.version !== this.currentVersion);
    if (previousNotes.length > 0) {
      const history = contentEl.createEl("details", { cls: "sink-update-notes-history" });
      history.createEl("summary", { text: "See recent updates" });
      for (const note of previousNotes) {
        const block = history.createDiv({ cls: "sink-update-note-block" });
        block.createEl("h4", { text: `${note.version} - ${note.title}` });
        const items = block.createEl("ul");
        for (const point of note.points) {
          items.createEl("li", { text: point });
        }
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

  private findNote(version: string): ReleaseNote | undefined {
    return LATEST_RELEASE_NOTES.find((entry) => entry.version === version);
  }
}
