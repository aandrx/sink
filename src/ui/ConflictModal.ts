import { App, Modal } from "obsidian";
import type { ConflictRevision } from "../settings";
import { renderSplitDiff } from "./DiffView";

let conflictSequence = 0;

type ConflictChoice = "mine" | "theirs";
type ConflictResolveHandler = (choice: ConflictChoice, revision?: string) => void;

export interface ConflictModalOptions {
  conflictRevisions?: ConflictRevision[];
  conflictRevision?: string;
  loadConflictPreview?: (rev: string) => Promise<{ localContent: string; remoteContent: string }>;
}

interface ConflictPreview {
  localContent: string;
  remoteContent: string;
}

function getRevisions(options: ConflictModalOptions): ConflictRevision[] | undefined {
  return options.conflictRevisions && options.conflictRevisions.length > 0 ? options.conflictRevisions : undefined;
}

function defaultRevision(options: ConflictModalOptions): string | undefined {
  const revisions = getRevisions(options);
  if (!revisions) return undefined;
  if (options.conflictRevision && revisions.some((revision) => revision.rev === options.conflictRevision)) {
    return options.conflictRevision;
  }
  return revisions[0]?.rev;
}

function shortRevision(rev: string): string {
  return rev.length > 10 ? rev.slice(0, 10) : rev;
}

function describeRevision(revision: ConflictRevision): string {
  const parts = [shortRevision(revision.rev)];
  if (revision.deleted) parts.push("deleted");
  if (revision.deviceName) parts.push(revision.deviceName);
  else if (revision.deviceId) parts.push(revision.deviceId);
  parts.push(new Date(revision.mtime).toLocaleString());
  return parts.join(" • ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown preview error";
}

export class ConflictModal extends Modal {
  private path: string;
  private mine: string;
  private theirs: string;
  private onResolve?: ConflictResolveHandler;
  private options: ConflictModalOptions;
  private selectedRevision?: string;
  private previewToken = 0;
  private resolved = false;

  constructor(
    app: App,
    path: string,
    mine: string,
    theirs: string,
    onResolveOrOptions?: ConflictResolveHandler | ConflictModalOptions,
    maybeOptions?: ConflictModalOptions
  ) {
    super(app);
    this.path = path;
    this.mine = mine;
    this.theirs = theirs;
    if (typeof onResolveOrOptions === "function") {
      this.onResolve = onResolveOrOptions;
      this.options = maybeOptions ?? {};
    } else {
      this.options = onResolveOrOptions ?? maybeOptions ?? {};
    }
    this.selectedRevision = defaultRevision(this.options);
  }

  onOpen() {
    this.modalEl.addClass("mod-sink-wide");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sink-conflict-modal", "sink-conflict-single");
    const titleId = `sink-conflict-title-${++conflictSequence}`;
    this.modalEl.setAttribute("aria-labelledby", titleId);
    contentEl.setAttribute("aria-labelledby", titleId);

    const heading = contentEl.createEl("h2", { text: "Sync conflict", attr: { id: titleId } });
    heading.tabIndex = -1;
    contentEl.createEl("p", { text: this.path, cls: "sink-conflict-path" });
    contentEl.createEl("p", {
      text: "This file was edited in more than one place. Choose one complete version; nothing is combined.",
      cls: "setting-item-description",
    });

    const choices = contentEl.createDiv({ cls: "sink-conflict-choices" });
    this.createChoice(
      choices,
      "Local",
      "Publishes this vault's version to the database, replacing the remote version.",
      `${titleId}-mine`
    );
    this.createChoice(
      choices,
      "Remote",
      "Changes this vault: the selected remote version replaces the local file.",
      `${titleId}-theirs`
    );

    const revisions = getRevisions(this.options);
    if (revisions) {
      contentEl.createEl("p", {
        text: "Applying a side resolves this conflict intentionally and retires the remote revisions that are not chosen. Any backup is stored locally on this device only.",
        cls: "setting-item-description sink-conflict-notice",
      });
      const controls = contentEl.createDiv({ cls: "sink-conflict-revisions" });
      const label = controls.createEl("label", { text: "Remote revision", cls: "sink-conflict-revision-label" });
      const selectId = `${titleId}-revision`;
      label.setAttribute("for", selectId);
      const select = controls.createEl("select", {
        cls: "sink-conflict-revision-select",
        attr: { id: selectId, "aria-label": `Remote revision for ${this.path}` },
      });
      for (const revision of revisions) {
        const option = select.createEl("option", { text: describeRevision(revision), attr: { value: revision.rev } });
        option.title = revision.rev;
      }
      select.value = this.selectedRevision ?? revisions[0].rev;
      const host = contentEl.createDiv({ cls: "sink-conflict-preview" });
      select.addEventListener("change", () => {
        this.selectedRevision = select.value;
        this.loadSelectedRevision(host, ++this.previewToken);
      });
      this.loadSelectedRevision(host, this.previewToken);
    } else if (this.mine || this.theirs) {
      renderSplitDiff(contentEl, "Local", "Remote", this.mine, this.theirs);
    } else {
      contentEl.createEl("p", {
        text: "No text preview is available for this file. Local publishes this vault's file; Remote replaces the local file. Choosing Leave both as they are keeps both sides unchanged.",
        cls: "setting-item-description sink-conflict-notice",
      });
    }

    const actions = contentEl.createDiv({ cls: "sink-conflict-actions" });
    const leaveButton = actions.createEl("button", {
      text: "Leave both as they are",
      cls: "sink-conflict-choice-leave",
      attr: { title: "Close without changing the local file or the remote copy" },
    });
    const mineButton = actions.createEl("button", {
      text: "Local",
      cls: "sink-conflict-choice-mine",
      attr: { "aria-describedby": `${titleId}-mine` },
    });
    const theirsButton = actions.createEl("button", {
      text: "Remote",
      cls: "sink-conflict-choice-theirs",
      attr: { "aria-describedby": `${titleId}-theirs` },
    });
    const choose = (choice?: ConflictChoice) => {
      if (this.resolved) return;
      this.resolved = true;
      leaveButton.disabled = true;
      mineButton.disabled = true;
      theirsButton.disabled = true;
      if (choice === "theirs") this.onResolve?.(choice, this.selectedRevision);
      else if (choice) this.onResolve?.(choice);
      this.close();
    };
    leaveButton.addEventListener("click", () => choose());
    mineButton.addEventListener("click", () => choose("mine"));
    theirsButton.addEventListener("click", () => choose("theirs"));
    mineButton.focus();
  }

  private createChoice(container: HTMLElement, label: string, description: string, id: string): void {
    const item = container.createDiv({ cls: "sink-conflict-choice" });
    item.createEl("strong", { text: label });
    item.createEl("span", { text: description });
    item.setAttribute("id", id);
  }

  private loadSelectedRevision(host: HTMLElement, token: number): void {
    host.empty();
    const revisions = getRevisions(this.options);
    if (!revisions) return;
    const selected = this.selectedRevision ?? defaultRevision(this.options);
    const revision = revisions.find((candidate) => candidate.rev === selected) ?? revisions[0];
    const loader = this.options.loadConflictPreview;
    if (typeof loader !== "function") {
      if (revision.rev === defaultRevision(this.options) && (this.mine || this.theirs)) {
        renderSplitDiff(host, "Local", "Remote", this.mine, this.theirs);
        return;
      }
      host.createEl("p", {
        text: `The contents of remote revision ${shortRevision(revision.rev)} are not available in this review. The revision metadata is shown instead. Choosing a side is still possible.`,
        cls: "setting-item-description sink-conflict-notice",
      });
      return;
    }

    const status = host.createEl("p", { text: "Loading selected remote revision...", cls: "setting-item-description" });
    status.setAttribute("aria-live", "polite");
    let pending: Promise<ConflictPreview>;
    try {
      pending = Promise.resolve(loader.call(this.options, revision.rev));
    } catch (error) {
      this.renderRevisionError(host, errorMessage(error));
      return;
    }
    pending.then((content) => {
      if (token !== this.previewToken) return;
      status.remove();
      if (!content || typeof content.localContent !== "string" || typeof content.remoteContent !== "string") {
        this.renderRevisionError(host, "the preview returned no text");
        return;
      }
      renderSplitDiff(host, "Local", "Remote", content.localContent, content.remoteContent);
    }).catch((error) => {
      if (token !== this.previewToken) return;
      status.remove();
      this.renderRevisionError(host, errorMessage(error));
    });
  }

  private renderRevisionError(host: HTMLElement, message: string): void {
    host.empty();
    host.createEl("p", {
      text: `Remote revision could not be loaded: ${message}. The revision metadata remains available and choosing a side is still possible.`,
      cls: "setting-item-description sink-conflict-notice sink-review-error",
    });
    const retry = host.createEl("button", { text: "Retry loading remote revision" });
    retry.addEventListener("click", () => this.loadSelectedRevision(host, ++this.previewToken));
  }

  onClose() {
    this.previewToken++;
    this.contentEl.empty();
  }
}
