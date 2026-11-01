import { App, Modal } from "obsidian";
import type { ChangeDecision, ConflictRevision, PendingChange, ReviewResult, ReviewedChange } from "../settings";
import { renderSplitDiff } from "./DiffView";

const PAGE_SIZE = 25;
let modalSequence = 0;

type SupportedDecision = "keep-local" | "keep-remote" | "skip";

interface RowState {
	selected: boolean;
	decision: SupportedDecision;
	conflictRevision?: string;
}

interface PreviewLoader {
	loadPreview?: () => Promise<{ localContent: string; remoteContent: string }>;
}

interface PreviewContent {
	localContent: string;
	remoteContent: string;
}

const DECISION_LABELS: Record<SupportedDecision, string> = {
	"keep-local": "Local",
	"keep-remote": "Remote",
	skip: "Skip",
};

function getConflictRevisions(change: PendingChange): ConflictRevision[] | undefined {
	return change.conflictRevisions && change.conflictRevisions.length > 0 ? change.conflictRevisions : undefined;
}

function defaultConflictRevision(change: PendingChange): string | undefined {
	const revisions = getConflictRevisions(change);
	if (!revisions) return undefined;
	if (change.conflictRevision && revisions.some((revision) => revision.rev === change.conflictRevision)) {
		return change.conflictRevision;
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

function retainedLabel(count: number): string {
	return `${count} remote revision${count === 1 ? "" : "s"} retained`;
}

function serverAbsent(change: PendingChange): boolean {
	return change.remoteExists === false;
}

function canKeepLocal(change: PendingChange): boolean {
	if (serverAbsent(change)) return change.localExists;
	if (change.remoteDeleted) return change.localExists;
	return true;
}

function canKeepRemote(change: PendingChange): boolean {
	if (serverAbsent(change)) return change.localExists;
	return true;
}

function createRowState(change: PendingChange): RowState {
	return {
		selected: true,
		decision: normalizeDecision(change.suggested, change),
		conflictRevision: defaultConflictRevision(change),
	};
}

function setRowDecision(change: PendingChange, state: RowState, decision: SupportedDecision): void {
	if (decision === "keep-local" && !canKeepLocal(change)) {
		decision = canKeepRemote(change) ? "keep-remote" : "skip";
	} else if (decision === "keep-remote" && !canKeepRemote(change)) {
		decision = canKeepLocal(change) ? "keep-local" : "skip";
	}
	state.decision = decision;
	const revisions = getConflictRevisions(change);
	if (!revisions) return;
	// Preserve the user's remote revision while Local is selected so switching
	// back to Remote cannot silently apply a different leaf than the diff showed.
	if (decision === "keep-remote") {
		const valid = state.conflictRevision && revisions.some((revision) => revision.rev === state.conflictRevision);
		if (!valid) state.conflictRevision = defaultConflictRevision(change);
	}
}

/** Merge has no true common ancestor here, so it is never offered. */
function normalizeDecision(decision: ChangeDecision | undefined, change: PendingChange): SupportedDecision {
	if (change.blockedReason) return "skip";
	if (decision === "keep-local") {
		if (canKeepLocal(change)) return "keep-local";
		return canKeepRemote(change) ? "keep-remote" : "skip";
	}
	if (decision === "keep-remote") {
		if (canKeepRemote(change)) return "keep-remote";
		return canKeepLocal(change) ? "keep-local" : "skip";
	}
	if (decision === "skip") return "skip";
	return "skip";
}

function getPreviewLoader(change: PendingChange): (() => Promise<PreviewContent>) | undefined {
	const loader = (change as PendingChange & PreviewLoader).loadPreview;
	return typeof loader === "function" ? () => loader.call(change) : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "unknown preview error";
}

export class BatchReviewModal extends Modal {
	private readonly changes: PendingChange[];
	private readonly changesByPath: Map<string, PendingChange>;
	private readonly title: string;
	private readonly states: Map<string, RowState> = new Map();
	private readonly resolver: (result: ReviewResult) => void;
	private resolved = false;
	private submitting = false;
	private closed = false;
	private page = 0;
	private activePath: string | null = null;
	private diffOpen = false;
	private previewToken = 0;
	private listEl: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;
	private previewHeadingEl: HTMLElement | null = null;
	private consequenceEl: HTMLElement | null = null;
	private pageStatusEl: HTMLElement | null = null;
	private selectionEl: HTMLElement | null = null;
	private footerNoteEl: HTMLElement | null = null;
	private previousButton: HTMLButtonElement | null = null;
	private nextButton: HTMLButtonElement | null = null;
	private readonly rowEls = new Map<string, HTMLElement>();
	private readonly applyButtons: HTMLButtonElement[] = [];

	constructor(app: App, title: string, changes: PendingChange[], resolver: (result: ReviewResult) => void) {
		super(app);
		this.title = title;
		this.changes = changes;
		this.changesByPath = new Map(changes.map((change) => [change.path, change]));
		this.resolver = resolver;
		this.activePath = changes[0]?.path ?? null;

		for (const change of changes) {
			this.states.set(change.path, createRowState(change));
		}
	}

	static async review(app: App, title: string, changes: PendingChange[]): Promise<ReviewResult> {
		return await new Promise<ReviewResult>((resolve) => {
			const modal = new BatchReviewModal(app, title, changes, resolve);
			modal.open();
		});
	}

	onOpen(): void {
		this.closed = false;
		this.modalEl.addClass("mod-sink-wide");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("sink-conflict-modal", "sink-review-modal");
		const titleId = `sink-review-title-${++modalSequence}`;
		this.modalEl.setAttribute("aria-labelledby", titleId);
		contentEl.setAttribute("aria-labelledby", titleId);

		const workspace = contentEl.createDiv({ cls: "sink-review-workspace" });
		const header = workspace.createDiv({ cls: "sink-review-header" });
		const heading = header.createEl("h2", { text: this.title, attr: { id: titleId } });
		heading.tabIndex = -1;
		header.createEl("p", {
			text: "Review this complete sync operation before anything is written. Local is this vault; Remote is the synced database copy.",
			cls: "setting-item-description",
		});
		const summary = header.createEl("p", {
			text: `${this.changes.length} file${this.changes.length === 1 ? "" : "s"} in this operation`,
			cls: "setting-item-description sink-review-summary",
		});
		this.selectionEl = summary.createSpan({ cls: "sink-review-selection-count" });

		const toolbar = workspace.createDiv({ cls: "sink-review-toolbar" });
		const selectionButtons = toolbar.createDiv({ cls: "sink-review-toolbar-group" });
		const selectAll = selectionButtons.createEl("button", { text: "Select all" });
		selectAll.addEventListener("click", () => {
			this.setAllSelection(true);
			this.renderList();
		});
		const deselectAll = selectionButtons.createEl("button", { text: "Deselect all" });
		deselectAll.addEventListener("click", () => {
			this.setAllSelection(false);
			this.renderList();
		});

		const bulk = toolbar.createDiv({ cls: "sink-review-toolbar-group" });
		const bulkLabel = bulk.createEl("label", { text: "Set selected to", cls: "sink-review-bulk-label" });
		const bulkSelect = bulk.createEl("select", { cls: "sink-review-bulk-select" });
		bulkLabel.setAttribute("for", `${titleId}-bulk`);
		bulkSelect.setAttribute("id", `${titleId}-bulk`);
		bulkSelect.createEl("option", { text: "Choose a decision", attr: { value: "" } });
		for (const decision of ["keep-local", "keep-remote", "skip"] as const) {
			bulkSelect.createEl("option", { text: DECISION_LABELS[decision], attr: { value: decision } });
		}
		bulkSelect.addEventListener("change", () => {
			const value = bulkSelect.value as SupportedDecision;
			if (value) this.applyDecisionToSelected(value);
			bulkSelect.value = "";
		});

		const body = workspace.createDiv({ cls: "sink-review-body" });
		const files = body.createDiv({ cls: "sink-review-files" });
		files.createEl("h3", { text: "Files in this operation", cls: "sink-review-section-title" });
		this.listEl = files.createDiv({
			cls: "sink-review-file-list",
			attr: { role: "list", "aria-label": "Files in this sync operation" },
		});
		const pager = files.createDiv({ cls: "sink-review-pager" });
		this.previousButton = pager.createEl("button", { text: "Previous", attr: { "aria-label": "Previous page of files" } });
		this.previousButton.addEventListener("click", () => this.setPage(this.page - 1));
		this.pageStatusEl = pager.createSpan({ cls: "sink-review-page-status" });
		this.pageStatusEl.setAttribute("aria-live", "polite");
		this.nextButton = pager.createEl("button", { text: "Next", attr: { "aria-label": "Next page of files" } });
		this.nextButton.addEventListener("click", () => this.setPage(this.page + 1));

		const preview = body.createDiv({ cls: "sink-review-preview" });
		preview.setAttribute("role", "region");
		preview.setAttribute("aria-label", "Selected file preview");
		this.previewEl = preview.createDiv({ cls: "sink-review-preview-content" });

		const footer = workspace.createDiv({ cls: "sink-review-footer" });
		this.footerNoteEl = footer.createEl("p", {
			text: "Apply writes the decisions for every selected file in one operation.",
			cls: "setting-item-description sink-review-footer-note",
		});
		const actions = footer.createDiv({ cls: "sink-review-footer-actions" });
		const cancelButton = actions.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => this.cancel());
		const applyButton = actions.createEl("button", { text: "Apply selected", cls: "mod-cta sink-review-apply" });
		applyButton.addEventListener("click", () => this.applySelected());
		this.applyButtons.push(applyButton);

		this.renderList();
		this.diffOpen = false;
		this.renderPreview(this.activePath ? this.changesByPath.get(this.activePath) ?? null : null, false);
		heading.focus();
	}

	onClose(): void {
		this.closed = true;
		this.previewToken++;
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolver({ approved: false, decisions: [] });
		}
	}

	private describeChange(change: PendingChange): string {
		const revisions = getConflictRevisions(change);
		if (change.blockedReason) {
			return revisions ? `${change.blockedReason} ${retainedLabel(revisions.length)}` : change.blockedReason;
		}
		const parts = [
			serverAbsent(change)
				? "Remote has no version"
				: change.remoteDeleted
					? "Remote deleted this file"
					: "Remote has a version",
		];
		if (revisions) parts.push(retainedLabel(revisions.length));
		parts.push(change.localExists ? "Local has a version" : "Not in the local vault");
		if (!serverAbsent(change)) parts.push(`Remote updated ${new Date(change.remoteMtime).toLocaleString()}`);
		if (change.localExists && change.localMtime) {
			parts.push(`Local updated ${new Date(change.localMtime).toLocaleString()}`);
		}
		if (serverAbsent(change) && !change.localExists) parts.push("No file on either side");
		return parts.join(" • ");
	}

	private renderList(preserveScroll = true): void {
		if (!this.listEl) return;
		const scrollTop = preserveScroll ? this.listEl.scrollTop : 0;
		this.listEl.empty();
		this.rowEls.clear();

		const start = this.page * PAGE_SIZE;
		const pageChanges = this.changes.slice(start, start + PAGE_SIZE);
		if (pageChanges.length === 0) {
			this.listEl.createEl("p", {
				text: "No files in this operation.",
				cls: "setting-item-description",
			});
		}
		for (const change of pageChanges) {
			this.createRow(this.listEl, change);
		}
		this.updateSelectionSummary();
		this.updatePager();
		this.listEl.scrollTop = scrollTop;
	}

	private createRow(parent: HTMLElement, change: PendingChange): HTMLElement {
		const state = this.states.get(change.path) ?? createRowState(change);
		const row = parent.createDiv({ cls: "sink-review-file-row" });
		row.setAttribute("role", "listitem");
		if (change.path === this.activePath) row.addClass("is-active");
		row.addEventListener("click", (event) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, select, button")) return;
			this.setActive(change.path, false, true);
		});

		const checkbox = row.createEl("input", { cls: "sink-review-file-select" });
		checkbox.type = "checkbox";
		checkbox.checked = state.selected;
		checkbox.disabled = !!change.blockedReason;
		checkbox.setAttribute("aria-label", `Include ${change.path} when applying`);
		checkbox.addEventListener("change", () => {
			const next = this.states.get(change.path) ?? state;
			next.selected = checkbox.checked;
			this.states.set(change.path, next);
			this.updateSelectionSummary();
		});

		const main = row.createDiv({ cls: "sink-review-file-main" });
		const pathButton = main.createEl("button", {
			text: change.path,
			cls: "sink-review-file-path",
			attr: { title: change.path },
		});
		if (change.path === this.activePath) pathButton.setAttribute("aria-current", "true");
		pathButton.addEventListener("click", () => this.setActive(change.path, true, true));
		main.createDiv({ cls: "sink-review-file-meta", text: this.describeChange(change) });

		const decision = row.createEl("select", {
			cls: "sink-review-decision",
			attr: { "aria-label": `Decision for ${change.path}` },
		});
		for (const value of ["keep-local", "keep-remote", "skip"] as const) {
			const label = value === "keep-remote" && serverAbsent(change)
				? `${DECISION_LABELS[value]} (no version)`
				: DECISION_LABELS[value];
			const option = decision.createEl("option", { text: label, attr: { value } });
			const available = value === "keep-local"
				? canKeepLocal(change)
				: value === "keep-remote"
					? canKeepRemote(change)
					: true;
			if (!available) {
				option.disabled = true;
				option.setText(`${DECISION_LABELS[value]} (unavailable)`);
			}
		}
		decision.value = state.decision;
		decision.disabled = !!change.blockedReason;
		decision.addEventListener("change", () => {
			const next = this.states.get(change.path) ?? state;
			setRowDecision(change, next, decision.value as SupportedDecision);
			this.states.set(change.path, next);
			decision.value = next.decision;
			this.updateSelectionSummary();
			if (change.path === this.activePath) {
				this.updateActiveConsequence();
				this.syncConflictSelection(change);
			}
		});

		this.rowEls.set(change.path, row);
		return row;
	}

	private setPage(page: number): void {
		const pageCount = Math.max(1, Math.ceil(this.changes.length / PAGE_SIZE));
		this.page = Math.min(Math.max(0, page), pageCount - 1);
		this.renderList(false);
		const first = this.changes[this.page * PAGE_SIZE];
		this.diffOpen = false;
		if (first) {
			this.setActive(first.path, false);
		} else {
			this.activePath = null;
			this.renderPreview(null, false);
		}
	}

	private updatePager(): void {
		const total = this.changes.length;
		const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
		const start = total === 0 ? 0 : this.page * PAGE_SIZE + 1;
		const end = Math.min(total, (this.page + 1) * PAGE_SIZE);
		if (this.pageStatusEl) {
			this.pageStatusEl.setText(total === 0 ? "No files" : `Page ${this.page + 1} of ${pageCount} • ${start}-${end} of ${total}`);
		}
		if (this.previousButton) this.previousButton.disabled = this.page <= 0;
		if (this.nextButton) this.nextButton.disabled = this.page >= pageCount - 1;
	}

	private updateSelectionSummary(): void {
		if (!this.selectionEl) return;
		const selected = this.changes.filter((change) => this.states.get(change.path)?.selected).length;
		this.selectionEl.setText(` • ${selected} of ${this.changes.length} selected`);
		const hasEffective = this.hasEffectiveDecisions();
		for (const button of this.applyButtons) button.disabled = this.submitting || !hasEffective;
		this.footerNoteEl?.setText(hasEffective
			? "Apply writes the decisions for every selected file in one operation."
			: "Nothing selected: choose Local or Remote for at least one file.");
	}

	private hasEffectiveDecisions(): boolean {
		return this.changes.some((change) => {
			const state = this.states.get(change.path);
			if (!state?.selected || state.decision === "skip") return false;
			if (state.decision === "keep-local") return canKeepLocal(change);
			if (state.decision === "keep-remote") return canKeepRemote(change);
			return false;
		});
	}

	private setActive(path: string, moveFocus: boolean, openDiff = false): void {
		this.activePath = path;
		this.diffOpen = openDiff;
		for (const [rowPath, row] of this.rowEls) {
			const active = rowPath === path;
			if (active) row.addClass("is-active");
			else row.removeClass("is-active");
			const button = row.querySelector<HTMLElement>(".sink-review-file-path");
			if (button) {
				if (active) button.setAttribute("aria-current", "true");
				else button.removeAttribute("aria-current");
			}
		}
		this.renderPreview(this.changesByPath.get(path) ?? null, moveFocus);
	}

	private renderPreview(change: PendingChange | null, moveFocus: boolean): void {
		const host = this.previewEl;
		if (!host) return;
		const token = ++this.previewToken;
		host.empty();
		this.previewHeadingEl = null;
		this.consequenceEl = null;

		if (!change) {
			host.createEl("p", {
				text: "Select a file box to view its details.",
				cls: "setting-item-description",
			});
			return;
		}

		const header = host.createDiv({ cls: "sink-review-preview-header" });
		const heading = header.createEl("h3", { text: change.path });
		heading.tabIndex = -1;
		this.previewHeadingEl = heading;
		if (moveFocus) heading.focus();
		header.createEl("p", {
			text: `Source device ${change.sourceDevice} • ${this.describeChange(change)}`,
			cls: "setting-item-description",
		});

		this.consequenceEl = host.createDiv({ cls: "sink-review-consequence" });
		this.consequenceEl.setAttribute("aria-live", "polite");
		this.updateActiveConsequence();

		if (!this.diffOpen) {
			const collapsed = host.createDiv({ cls: "sink-review-preview-body" });
			collapsed.createEl("p", {
				text: "Open a file box, or focus its name and press Enter, to view the diff.",
				cls: "sink-review-notice",
			});
			return;
		}

		if (serverAbsent(change)) {
			this.renderAbsentServerPreview(host, change);
			return;
		}

		if (getConflictRevisions(change)) {
			this.renderConflictPreview(host, change);
			return;
		}

		const body = host.createDiv({ cls: "sink-review-preview-body" });
		if (change.isBinary) {
			body.createEl("p", {
				text: "Binary file. No text diff is available. Local publishes this vault's binary; Remote adopts the remote binary; Skip changes neither.",
				cls: "sink-review-notice",
			});
			return;
		}

		const loader = getPreviewLoader(change);
		if (loader) {
			const status = body.createEl("p", { cls: "sink-review-notice", text: "Loading preview..." });
			status.setAttribute("aria-live", "polite");
			let pending: Promise<PreviewContent>;
			try {
				pending = Promise.resolve(loader());
			} catch (error) {
				this.renderPreviewError(body, change, errorMessage(error));
				return;
			}
			pending.then((content) => {
				if (token !== this.previewToken || this.closed || !this.previewEl) return;
				status.remove();
				if (!content || typeof content.localContent !== "string" || typeof content.remoteContent !== "string") {
					this.renderPreviewError(body, change, "the preview returned no text");
					return;
				}
				renderSplitDiff(body, "Local", "Remote", content.localContent, content.remoteContent);
			}).catch((error) => {
				if (token !== this.previewToken || this.closed || !this.previewEl) return;
				status.remove();
				this.renderPreviewError(body, change, errorMessage(error));
			});
			return;
		}

		if (change.localContent === undefined && change.remoteContent === undefined) {
			body.createEl("p", {
				text: "Preview unavailable for this file. Local publishes this vault's file; Remote adopts the remote version; Skip changes neither.",
				cls: "sink-review-notice",
			});
			return;
		}
		renderSplitDiff(body, "Local", "Remote", change.localContent ?? "", change.remoteContent ?? "");
	}

	private renderAbsentServerPreview(host: HTMLElement, change: PendingChange): void {
		const body = host.createDiv({ cls: "sink-review-preview-body" });
		let text: string;
		if (!change.localExists) {
			text = "Remote has no version and the local vault has no file at this path. Skip changes nothing; applying either side is unavailable until one side has a file.";
		} else if (change.isBinary) {
			text = "Binary file. Remote has no version and no text diff is available. Local publishes this vault's binary; Remote leaves the local file unchanged; nothing is deleted or uploaded; Skip changes neither.";
		} else {
			text = "Remote has no version, so there is no remote text to compare. Local publishes this vault's file; Remote leaves the local file unchanged; nothing is deleted or uploaded; Skip changes neither.";
		}
		body.createEl("p", { text, cls: "sink-review-notice" });
	}

	private renderConflictPreview(host: HTMLElement, change: PendingChange): void {
		const revisions = getConflictRevisions(change);
		if (!revisions) return;
		const body = host.createDiv({ cls: "sink-review-preview-body" });
		body.createEl("p", {
			text: "Retained remote revisions. Applying a side resolves this conflict intentionally: the remote revisions that are not chosen are retired, and any backup is stored locally on this device only.",
			cls: "sink-review-notice",
		});

		const controls = body.createDiv({ cls: "sink-review-conflict-controls" });
		const selectId = `sink-review-revision-${++modalSequence}`;
		const label = controls.createEl("label", { text: "Remote revision", cls: "sink-review-conflict-label" });
		label.setAttribute("for", selectId);
		const select = controls.createEl("select", {
			cls: "sink-review-revision-select",
			attr: { id: selectId, "aria-label": `Remote revision for ${change.path}` },
		});
		for (const revision of revisions) {
			const option = select.createEl("option", { text: describeRevision(revision), attr: { value: revision.rev } });
			option.title = revision.rev;
		}
		const state = this.states.get(change.path) ?? createRowState(change);
		select.value = state.conflictRevision ?? defaultConflictRevision(change) ?? revisions[0].rev;
		select.disabled = !!change.blockedReason;

		const content = body.createDiv({ cls: "sink-review-conflict-content" });
		select.addEventListener("change", () => {
			const next = this.states.get(change.path) ?? state;
			next.conflictRevision = select.value;
			this.states.set(change.path, next);
			if (change.path === this.activePath) this.updateActiveConsequence();
			if (!change.isBinary) this.loadConflictLeaf(change, content, ++this.previewToken);
		});

		if (change.isBinary) {
			body.createEl("p", {
				text: "Binary file. The retained remote revisions cannot be shown as text. The selected revision can still be adopted or the local binary can be published; applying intentionally retires the revisions that are not chosen.",
				cls: "sink-review-notice",
			});
			return;
		}
		this.loadConflictLeaf(change, content, this.previewToken);
	}

	private loadConflictLeaf(change: PendingChange, host: HTMLElement, token: number): void {
		host.empty();
		const revisions = getConflictRevisions(change);
		if (!revisions) return;
		const selected = this.states.get(change.path)?.conflictRevision ?? defaultConflictRevision(change);
		const revision = revisions.find((candidate) => candidate.rev === selected) ?? revisions[0];
		const loader = change.loadConflictPreview;
		if (typeof loader !== "function") {
			host.createEl("p", {
				text: `The contents of remote revision ${shortRevision(revision.rev)} are not available in this review. The revision metadata is shown instead. Choosing a side is still possible and applies an intentional resolution.`,
				cls: "sink-review-notice",
			});
			return;
		}

		const status = host.createEl("p", { text: "Loading selected remote revision...", cls: "sink-review-notice" });
		status.setAttribute("aria-live", "polite");
		let pending: Promise<PreviewContent>;
		try {
			pending = Promise.resolve(loader.call(change, revision.rev));
		} catch (error) {
			this.renderConflictLeafError(host, change, errorMessage(error));
			return;
		}
		pending.then((content) => {
			if (token !== this.previewToken || this.closed || !this.previewEl) return;
			status.remove();
			if (!content || typeof content.localContent !== "string" || typeof content.remoteContent !== "string") {
				this.renderConflictLeafError(host, change, "the preview returned no text");
				return;
			}
			renderSplitDiff(host, "Local", "Remote", content.localContent, content.remoteContent);
		}).catch((error) => {
			if (token !== this.previewToken || this.closed || !this.previewEl) return;
			status.remove();
			this.renderConflictLeafError(host, change, errorMessage(error));
		});
	}

	private renderConflictLeafError(host: HTMLElement, change: PendingChange, message: string): void {
		host.empty();
		host.createEl("p", {
			text: `Remote revision could not be loaded: ${message}. The revision metadata remains available and choosing a side is still possible.`,
			cls: "sink-review-notice sink-review-error",
		});
		const retry = host.createEl("button", { text: "Retry remote revision", cls: "sink-review-retry" });
		retry.addEventListener("click", () => {
			if (this.activePath !== change.path) return;
			this.loadConflictLeaf(change, host, ++this.previewToken);
		});
	}

	private renderPreviewError(body: HTMLElement, change: PendingChange, message: string): void {
		body.createEl("p", {
			text: `Preview could not be loaded: ${message}. The review is still usable; choose a decision from the file list.`,
			cls: "sink-review-notice sink-review-error",
		});
		if (change.localContent !== undefined || change.remoteContent !== undefined) {
			body.createEl("p", {
				text: "Showing the preview data already provided for this review.",
				cls: "setting-item-description",
			});
			renderSplitDiff(body, "Local", "Remote", change.localContent ?? "", change.remoteContent ?? "");
		}
		const retry = body.createEl("button", { text: "Retry preview", cls: "sink-review-retry" });
		retry.addEventListener("click", () => {
			if (this.activePath === change.path) this.renderPreview(change, false);
		});
	}

	private updateActiveConsequence(): void {
		if (!this.consequenceEl || !this.activePath) return;
		const change = this.changesByPath.get(this.activePath);
		if (!change) return;
		const decision = this.states.get(change.path)?.decision ?? normalizeDecision(change.suggested, change);
		this.consequenceEl.setText(this.decisionConsequence(change, decision));
	}

	private decisionConsequence(change: PendingChange, decision: SupportedDecision): string {
		if (change.blockedReason) return change.blockedReason;
		if (serverAbsent(change)) return this.absentServerConsequence(change, decision);
		const revisions = getConflictRevisions(change);
		if (revisions) return this.conflictDecisionConsequence(change, revisions, decision);
		if (decision === "keep-local") {
			if (!canKeepLocal(change)) {
				return "Local is unavailable because this file is not in the local vault.";
			}
			if (!change.localExists) {
				return "Local publishes a deletion. The remote copy of this file is deleted; the local vault stays without the file.";
			}
			if (change.remoteDeleted) {
				return "Local republishes this file to the database, restoring it remotely.";
			}
			return "Local publishes this vault's contents, replacing the remote version.";
		}
		if (decision === "keep-remote") {
			if (change.remoteDeleted) {
				return "Remote deletes this file in the local vault. Skip changes neither.";
			}
			if (!change.localExists) {
				return "Remote restores this file in the local vault from the remote version.";
			}
			return "Remote changes this vault: the remote version replaces the local file.";
		}
		return "Skip changes neither the local vault nor the database.";
	}

	private absentServerConsequence(change: PendingChange, decision: SupportedDecision): string {
		if (decision === "keep-local") {
			if (!change.localExists) {
				return "Local is unavailable because the file is missing locally and remotely.";
			}
			return "Local publishes this vault's file. Remote has no version, so this creates it.";
		}
		if (decision === "keep-remote") {
			if (!change.localExists) {
				return "The file is missing both locally and remotely. Remote changes nothing.";
			}
			return "Remote leaves the local file unchanged; nothing is deleted or uploaded because remote has no version.";
		}
		return change.localExists
			? "Skip changes neither the local vault nor the database; the local file stays and nothing is uploaded."
			: "Skip changes nothing because the file is missing both locally and remotely.";
	}

	private conflictDecisionConsequence(change: PendingChange, revisions: ConflictRevision[], decision: SupportedDecision): string {
		const selectedRev = this.states.get(change.path)?.conflictRevision ?? defaultConflictRevision(change);
		const selected = revisions.find((revision) => revision.rev === selectedRev) ?? revisions[0];
		const otherCount = Math.max(0, revisions.length - 1);
		if (decision === "keep-local") {
			return `Applying resolves this conflict by publishing the local contents as the winner and retiring all ${revisions.length} retained remote revision${revisions.length === 1 ? "" : "s"}. Any backup is stored locally on this device only.`;
		}
		if (decision === "keep-remote") {
			const target = `remote revision ${shortRevision(selected.rev)}${selected.deleted ? " (deleted)" : ""}`;
			const retirement = otherCount > 0
				? ` and retiring ${otherCount} other retained remote revision${otherCount === 1 ? "" : "s"}`
				: " and retiring no other retained revisions";
			return `Applying resolves this conflict by adopting ${target} in the local vault${retirement}. Any backup is stored locally on this device only.`;
		}
		return `Skip leaves this conflict and ${revisions.length} retained remote revision${revisions.length === 1 ? "" : "s"} unresolved. Applying a side intentionally retires the revisions that are not chosen.`;
	}

	private setAllSelection(selected: boolean): void {
		for (const change of this.changes) {
			const state = this.states.get(change.path) ?? createRowState(change);
			state.selected = selected;
			this.states.set(change.path, state);
		}
	}

	private applyDecisionToSelected(decision: SupportedDecision): void {
		for (const change of this.changes) {
			const state = this.states.get(change.path) ?? createRowState(change);
			if (!state.selected || change.blockedReason) continue;
			if (decision === "keep-local" && !canKeepLocal(change)) continue;
			if (decision === "keep-remote" && !canKeepRemote(change)) continue;
			setRowDecision(change, state, decision);
			this.states.set(change.path, state);
		}
		this.renderList();
		this.updateActiveConsequence();
		const active = this.activePath ? this.changesByPath.get(this.activePath) : undefined;
		if (active) this.syncConflictSelection(active);
	}

	private syncConflictSelection(change: PendingChange): void {
		if (!getConflictRevisions(change)) return;
		const select = this.previewEl?.querySelector<HTMLSelectElement>(".sink-review-revision-select");
		if (!select) return;
		select.value = this.states.get(change.path)?.conflictRevision ?? defaultConflictRevision(change) ?? select.value;
	}

	private collectDecisions(): ReviewedChange[] {
		return this.changes.map((change) => {
			const state = this.states.get(change.path) ?? { selected: false, decision: "skip" };
			const decision = state.selected ? state.decision : "skip";
			const reviewed: ReviewedChange = {
				path: change.path,
				selected: state.selected,
				decision,
			};
			if (decision === "keep-remote" && getConflictRevisions(change)) {
				reviewed.conflictRevision = state.conflictRevision ?? defaultConflictRevision(change);
			}
			return reviewed;
		});
	}

	private cancel(): void {
		this.resolveAndClose({ approved: false, decisions: [] });
	}

	private applySelected(): void {
		if (this.resolved || this.submitting || !this.hasEffectiveDecisions()) return;
		this.submitting = true;
		for (const button of this.applyButtons) button.disabled = true;
		this.resolveAndClose({ approved: true, decisions: this.collectDecisions() });
	}

	private resolveAndClose(result: ReviewResult): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolver(result);
		this.close();
	}
}
