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
			contentEl.createEl("p", {
				text: "Split diff view. Green lines are additions, red lines are removals or replacements.",
				cls: "setting-item-description",
			});

			if (change.isBinary) {
				contentEl.createEl("p", {
					text: "Binary file preview is not supported. Choose keep local or keep remote.",
					cls: "setting-item-description",
				});
				return;
			}

			const wrapper = contentEl.createDiv({ cls: "sink-diff-split" });
			const leftPane = wrapper.createDiv({ cls: "sink-diff-pane sink-diff-left" });
			const rightPane = wrapper.createDiv({ cls: "sink-diff-pane sink-diff-right" });

			leftPane.createEl("h4", { text: "Local" });
			rightPane.createEl("h4", { text: "Remote" });

			const rows = this.buildSplitDiff(change.localContent ?? "", change.remoteContent ?? "");
			for (const row of rows) {
				const leftRow = leftPane.createDiv({ cls: `sink-diff-row sink-diff-${row.kind}` });
				leftRow.createDiv({ cls: "sink-diff-line-number", text: row.leftNumber ?? "" });
				leftRow.createDiv({ cls: "sink-diff-line-text", text: row.leftText ?? "" });

				const rightRow = rightPane.createDiv({ cls: `sink-diff-row sink-diff-${row.kind}` });
				rightRow.createDiv({ cls: "sink-diff-line-number", text: row.rightNumber ?? "" });
				rightRow.createDiv({ cls: "sink-diff-line-text", text: row.rightText ?? "" });
			}
		};
		popup.open();
	}

	private buildSplitDiff(leftText: string, rightText: string): Array<{
		kind: "equal" | "delete" | "insert" | "change";
		leftNumber?: string;
		leftText?: string;
		rightNumber?: string;
		rightText?: string;
	}> {
		const leftLines = leftText.split(/\r?\n/);
		const rightLines = rightText.split(/\r?\n/);
		const rows: Array<{
			kind: "equal" | "delete" | "insert" | "change";
			leftNumber?: string;
			leftText?: string;
			rightNumber?: string;
			rightText?: string;
		}> = [];

		let leftIndex = 0;
		let rightIndex = 0;

		while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
			const leftLine = leftLines[leftIndex];
			const rightLine = rightLines[rightIndex];

			if (leftLine === rightLine) {
				rows.push({
					kind: "equal",
					leftNumber: String(leftIndex + 1),
					leftText: leftLine ?? "",
					rightNumber: String(rightIndex + 1),
					rightText: rightLine ?? "",
				});
				leftIndex += 1;
				rightIndex += 1;
				continue;
			}

			if (leftLine !== undefined && rightLines[rightIndex + 1] === leftLine) {
				rows.push({
					kind: "insert",
					leftNumber: "",
					leftText: "",
					rightNumber: String(rightIndex + 1),
					rightText: rightLine ?? "",
				});
				rightIndex += 1;
				continue;
			}

			if (rightLine !== undefined && leftLines[leftIndex + 1] === rightLine) {
				rows.push({
					kind: "delete",
					leftNumber: String(leftIndex + 1),
					leftText: leftLine ?? "",
					rightNumber: "",
					rightText: "",
				});
				leftIndex += 1;
				continue;
			}

			if (leftLine !== undefined && rightLine !== undefined) {
				rows.push({
					kind: "change",
					leftNumber: String(leftIndex + 1),
					leftText: leftLine,
					rightNumber: String(rightIndex + 1),
					rightText: rightLine,
				});
				leftIndex += 1;
				rightIndex += 1;
				continue;
			}

			if (leftLine !== undefined) {
				rows.push({
					kind: "delete",
					leftNumber: String(leftIndex + 1),
					leftText: leftLine,
					rightNumber: "",
					rightText: "",
				});
				leftIndex += 1;
				continue;
			}

			if (rightLine !== undefined) {
				rows.push({
					kind: "insert",
					leftNumber: "",
					leftText: "",
					rightNumber: String(rightIndex + 1),
					rightText: rightLine,
				});
				rightIndex += 1;
			}
		}

		return rows;
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
