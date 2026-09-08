import { App, Modal } from "obsidian";

export interface SplitDiffRow {
  kind: "equal" | "delete" | "insert" | "change";
  leftNumber?: string;
  leftText?: string;
  rightNumber?: string;
  rightText?: string;
}

export function buildSplitDiff(leftText: string, rightText: string): SplitDiffRow[] {
  const leftLines = leftText.split(/\r?\n/);
  const rightLines = rightText.split(/\r?\n/);
  const rows: SplitDiffRow[] = [];

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

export function renderSplitDiff(container: HTMLElement, leftLabel: string, rightLabel: string, leftText: string, rightText: string): void {
  const wrapper = container.createDiv({ cls: "sink-diff-split" });
  const leftPane = wrapper.createDiv({ cls: "sink-diff-pane sink-diff-left" });
  const rightPane = wrapper.createDiv({ cls: "sink-diff-pane sink-diff-right" });

  leftPane.createEl("h4", { text: leftLabel });
  rightPane.createEl("h4", { text: rightLabel });

  const rows = buildSplitDiff(leftText, rightText);
  for (const row of rows) {
    const leftRow = leftPane.createDiv({ cls: `sink-diff-row sink-diff-${row.kind}` });
    leftRow.createDiv({ cls: "sink-diff-line-number", text: row.leftNumber ?? "" });
    leftRow.createDiv({ cls: "sink-diff-line-text", text: row.leftText ?? "" });

    const rightRow = rightPane.createDiv({ cls: `sink-diff-row sink-diff-${row.kind}` });
    rightRow.createDiv({ cls: "sink-diff-line-number", text: row.rightNumber ?? "" });
    rightRow.createDiv({ cls: "sink-diff-line-text", text: row.rightText ?? "" });
  }
}

export function openSplitDiffModal(
  app: App,
  title: string,
  leftLabel: string,
  rightLabel: string,
  leftText: string,
  rightText: string,
  subtitle?: string
): void {
  const modal = new Modal(app);
  modal.onOpen = () => {
    modal.modalEl.addClass("mod-sink-wide");
    const { contentEl } = modal;
    contentEl.empty();
    contentEl.addClass("sink-conflict-modal");
    contentEl.createEl("h3", { text: title });
    if (subtitle) {
      contentEl.createEl("p", { text: subtitle, cls: "setting-item-description" });
    }
    renderSplitDiff(contentEl, leftLabel, rightLabel, leftText, rightText);
  };
  modal.open();
}
