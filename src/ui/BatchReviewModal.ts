import { App, Modal, Setting } from "obsidian";
import type { ChangeDecision, PendingChange, ReviewResult, ReviewedChange } from "../settings";

interface RowState {
	selected: boolean;
	decision: ChangeDecision;
}

export class BatchReviewModal extends Modal {
	private readonly changes: PendingChange[];
	private readonly title: string;
	private readonly states: Map<string, RowState> = new Map();
	private readonly resolver: (result: ReviewResult) => void;
	private resolved = false;
	private listEl: HTMLElement | null = null;

	constructor(app: App, title: string, changes: PendingChange[], resolver: (result: ReviewResult) => void) {
		super(app);
		this.title = title;
		this.changes = changes;
		this.resolver = resolver;

		for (const change of changes) {
			this.states.set(change.path, {
				selected: true,
				decision: change.suggested,
			});
		}
	}

	static async review(app: App, title: string, changes: PendingChange[]): Promise<ReviewResult> {
		return await new Promise<ReviewResult>((resolve) => {
			const modal = new BatchReviewModal(app, title, changes, resolve);
			modal.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("sink-conflict-modal");

		contentEl.createEl("h2", { text: this.title });
		contentEl.createEl("p", {
			text: "Review risky sync changes before applying. Choose what to keep for each file.",
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Select all").onClick(() => {
					this.setAllSelection(true);
					this.renderRows();
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Deselect all").onClick(() => {
					this.setAllSelection(false);
					this.renderRows();
				})
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("keep-remote", "Apply to selected: keep remote")
					.addOption("keep-local", "Apply to selected: keep local")
					.addOption("merge", "Apply to selected: merge")
					.onChange((value) => {
						this.applyDecisionToSelected(value as ChangeDecision);
						this.renderRows();
					})
			);

		this.listEl = contentEl.createDiv({ cls: "sink-batch-list" });
		this.renderRows();

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.resolveAndClose({ approved: false, decisions: [] });
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Apply Selected")
					.setCta()
					.onClick(() => {
						const decisions = this.collectDecisions();
						this.resolveAndClose({ approved: true, decisions });
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolver({ approved: false, decisions: [] });
		}
	}

	private renderRows(): void {
		if (!this.listEl) return;
		this.listEl.empty();

		for (const change of this.changes) {
			const state = this.states.get(change.path) ?? { selected: true, decision: change.suggested };
			const row = this.listEl.createDiv({ cls: "sink-batch-row" });
			const label = `${change.path} (${change.sourceDevice})`;
			const desc = this.describeChange(change);

			new Setting(row)
				.setName(label)
				.setDesc(desc)
				.addToggle((toggle) =>
					toggle
						.setValue(state.selected)
						.onChange((value) => {
							const next = this.states.get(change.path) ?? { selected: true, decision: change.suggested };
							next.selected = value;
							this.states.set(change.path, next);
						})
				)
				.addDropdown((dropdown) =>
					dropdown
						.addOption("keep-remote", "Keep remote")
						.addOption("keep-local", "Keep local")
						.addOption("merge", "Merge")
						.addOption("skip", "Skip")
						.setValue(state.decision)
						.onChange((value) => {
							const next = this.states.get(change.path) ?? { selected: true, decision: change.suggested };
							next.decision = value as ChangeDecision;
							this.states.set(change.path, next);
						})
				)
				.addButton((btn) =>
					btn.setButtonText("View diff").onClick(() => {
						this.showDiff(change);
					})
				);
		}
	}

	private describeChange(change: PendingChange): string {
		const remoteStamp = new Date(change.remoteMtime).toLocaleString();
		const localStamp = change.localMtime ? new Date(change.localMtime).toLocaleString() : "none";
		const remote = change.remoteDeleted ? "remote deleted" : "remote changed";
		const local = change.localExists ? "local exists" : "local missing";
		return `${remote} • ${local} • remote mtime ${remoteStamp} • local mtime ${localStamp}`;
	}

	private showDiff(change: PendingChange): void {
		const popup = new Modal(this.app);
		popup.onOpen = () => {
			const { contentEl } = popup;
			contentEl.empty();
			contentEl.createEl("h3", { text: change.path });
			contentEl.createEl("p", { text: `Source device: ${change.sourceDevice}` });

			if (change.isBinary) {
				contentEl.createEl("p", {
					text: "Binary file preview is not supported. Choose keep local or keep remote.",
					cls: "setting-item-description",
				});
				return;
			}

			const wrapper = contentEl.createDiv({ cls: "sink-diff-container" });
			const localDiv = wrapper.createDiv({ cls: "sink-diff-side" });
			localDiv.createEl("h4", { text: "Local" });
			localDiv.createEl("pre", { text: this.truncate(change.localContent ?? "", 4000) });

			const remoteDiv = wrapper.createDiv({ cls: "sink-diff-side" });
			remoteDiv.createEl("h4", { text: "Remote" });
			remoteDiv.createEl("pre", { text: this.truncate(change.remoteContent ?? "", 4000) });
		};
		popup.open();
	}

	private setAllSelection(selected: boolean): void {
		for (const change of this.changes) {
			const state = this.states.get(change.path) ?? { selected: true, decision: change.suggested };
			state.selected = selected;
			this.states.set(change.path, state);
		}
	}

	private applyDecisionToSelected(decision: ChangeDecision): void {
		for (const change of this.changes) {
			const state = this.states.get(change.path) ?? { selected: true, decision: change.suggested };
			if (state.selected) {
				state.decision = decision;
			}
			this.states.set(change.path, state);
		}
	}

	private collectDecisions(): ReviewedChange[] {
		return this.changes.map((change) => {
			const state = this.states.get(change.path) ?? { selected: false, decision: "skip" };
			return {
				path: change.path,
				selected: state.selected,
				decision: state.selected ? state.decision : "skip",
			};
		});
	}

	private resolveAndClose(result: ReviewResult): void {
		this.resolved = true;
		this.resolver(result);
		this.close();
	}

	private truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		return text.slice(0, maxLen) + "\n... (truncated)";
	}
}
