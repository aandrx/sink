import { App, Modal } from "obsidian";
import { diff_match_patch } from "diff-match-patch";

const MAX_DIFF_CHARS = 1024 * 1024;
const MAX_DIFF_LINES = 4000;
const CONTEXT_LINES = 3;

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface SplitDiffRow {
  kind: "equal" | "delete" | "insert" | "change";
  leftNumber?: string;
  leftText?: string;
  rightNumber?: string;
  rightText?: string;
  leftSegments?: DiffSegment[];
  rightSegments?: DiffSegment[];
}

export interface DiffFold {
  kind: "fold";
  start: number;
  end: number;
  count: number;
}

export type DiffDisplayRow = { kind: "line"; index: number; row: SplitDiffRow } | DiffFold;

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/\r?\n/);
}

function assertPreviewSize(left: string, right: string): void {
  if (left.length + right.length > MAX_DIFF_CHARS ||
      splitLines(left).length + splitLines(right).length > MAX_DIFF_LINES) {
    throw new Error("This diff is too large to preview safely");
  }
}

/** Diff line tokens, not adjacent line guesses: multi-line insertions stay aligned. */
export function buildSplitDiff(leftText: string, rightText: string): SplitDiffRow[] {
  assertPreviewSize(leftText, rightText);
  const leftLines = splitLines(leftText);
  const rightLines = splitLines(rightText);
  const lines: string[] = [""];
  const tokens = new Map<string, number>();
  const encode = (input: string[]) => input.map((line) => {
    let token = tokens.get(line);
    if (token === undefined) {
      token = lines.length;
      tokens.set(line, token);
      lines.push(line);
    }
    return String.fromCharCode(token);
  }).join("");

  const dmp = new diff_match_patch();
  dmp.Diff_Timeout = 0.15;
  const diffs = dmp.diff_main(encode(leftLines), encode(rightLines), false);
  const rows: SplitDiffRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  let deleted: string[] = [];
  let inserted: string[] = [];
  // Bound character-diff work across the entire preview as well as per line.
  let inlineBudget = 64000;
  const inlineDeadline = Date.now() + 50;
  const flushChanges = () => {
    for (let i = 0; i < Math.max(deleted.length, inserted.length); i++) {
      const left = deleted[i];
      const right = inserted[i];
      const row: SplitDiffRow = {
        kind: left !== undefined && right !== undefined ? "change" : left !== undefined ? "delete" : "insert",
        leftNumber: left !== undefined ? String(++leftIndex) : undefined,
        rightNumber: right !== undefined ? String(++rightIndex) : undefined,
        leftText: left,
        rightText: right,
      };
      if (row.kind === "change" && left!.length + right!.length <= 2048 && inlineBudget >= left!.length + right!.length && Date.now() < inlineDeadline) {
        inlineBudget -= left!.length + right!.length;
        dmp.Diff_Timeout = 0.005;
        const inline = dmp.diff_main(left!, right!, false);
        row.leftSegments = inline.filter(([kind]) => kind !== 1).map(([kind, text]) => ({ text, changed: kind === -1 }));
        row.rightSegments = inline.filter(([kind]) => kind !== -1).map(([kind, text]) => ({ text, changed: kind === 1 }));
      }
      rows.push(row);
    }
    deleted = [];
    inserted = [];
  };

  for (const [kind, content] of diffs) {
    const values = Array.from(content, (token) => lines[token.charCodeAt(0)]);
    if (kind === -1) deleted.push(...values);
    else if (kind === 1) inserted.push(...values);
    else {
      flushChanges();
      for (const text of values) {
        rows.push({ kind: "equal", leftNumber: String(++leftIndex), rightNumber: String(++rightIndex), leftText: text, rightText: text });
      }
    }
  }
  flushChanges();
  return rows;
}

/** Fold only equal rows, retaining three context lines around every change. */
export function buildDiffDisplayRows(rows: SplitDiffRow[], expanded: ReadonlySet<number> = new Set(), showAll = false): DiffDisplayRow[] {
  const display: DiffDisplayRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "equal") {
      display.push({ kind: "line", index, row: rows[index++] });
      continue;
    }
    const start = index;
    while (index < rows.length && rows[index].kind === "equal") index++;
    const foldStart = start + CONTEXT_LINES;
    const foldEnd = index - CONTEXT_LINES;
    for (let current = start; current < index; current++) {
      if (!showAll && !expanded.has(foldStart) && foldEnd - foldStart > 1 && current === foldStart) {
        display.push({ kind: "fold", start: foldStart, end: foldEnd, count: foldEnd - foldStart });
        current = foldEnd - 1;
      } else display.push({ kind: "line", index: current, row: rows[current] });
    }
  }
  return display;
}

/** Self-contained styling: works in batch, conflict, and snapshot modals alike. */
export function renderSplitDiff(container: HTMLElement, leftLabel: string, rightLabel: string, leftText: string, rightText: string): void {
  let rows: SplitDiffRow[];
  try {
    rows = buildSplitDiff(leftText, rightText);
  } catch {
    container.createEl("p", { text: "Preview omitted for safety: this diff is too large. Review the files externally, then choose keep local or keep remote." });
    return;
  }

  const view = container.createDiv({ cls: "sink-diff-view" });
  view.setAttribute("role", "region");
  view.setAttribute("aria-label", `${leftLabel} and ${rightLabel} side-by-side comparison`);
  const toolbar = view.createDiv({ cls: "sink-diff-toolbar" });
  const removed = rows.filter((row) => row.leftNumber !== undefined && row.kind !== "equal").length;
  const added = rows.filter((row) => row.rightNumber !== undefined && row.kind !== "equal").length;
  const summary = toolbar.createDiv({ cls: "sink-diff-summary" });
  if (removed === 0 && added === 0) summary.setText("No differences");
  else {
    summary.createSpan({ cls: "sink-diff-count-removed", text: `−${removed} removed` });
    summary.createSpan({ cls: "sink-diff-count-added", text: `+${added} added` });
  }
  const controls = toolbar.createDiv({ cls: "sink-diff-controls" });
  const contextButton = controls.createEl("button", { text: "Show all lines", cls: "sink-diff-context-button" });
  contextButton.setAttribute("aria-pressed", "false");
  const position = controls.createSpan({ cls: "sink-diff-position" });
  position.setAttribute("aria-live", "polite");
  const previous = controls.createEl("button", { text: "↑", attr: { "aria-label": "Previous change", title: "Previous change" } });
  const next = controls.createEl("button", { text: "↓", attr: { "aria-label": "Next change", title: "Next change" } });
  const split = view.createDiv({ cls: "sink-diff-split" });

  const createPane = (side: "left" | "right", label: string) => {
    const pane = split.createDiv({ cls: `sink-diff-pane sink-diff-${side}` });
    const header = pane.createDiv({ cls: "sink-diff-header" });
    header.createSpan({ cls: "sink-diff-header-label", text: label });
    header.createSpan({ cls: "sink-diff-header-detail", text: side === "left" ? "Original" : "Comparison" });
    const scroll = pane.createDiv({ cls: "sink-diff-scroll" });
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", `${label} file contents`);
    const body = scroll.createDiv({ cls: "sink-diff-lines" });
    return { scroll, body };
  };
  const left = createPane("left", leftLabel);
  const right = createPane("right", rightLabel);
  // Give both bodies the same width so a short side cannot clamp horizontal
  // scrolling and bounce the other side back. Lines never wrap out of alignment.
  const longest = rows.reduce((length, row) => Math.max(length, row.leftText?.length ?? 0, row.rightText?.length ?? 0), 0);
  const width = `max(100%, calc(${longest * 2 + 1}ch + 6em))`;
  // Actual sizing is measured after rendering below; this is a no-layout fallback.
  left.body.style.minWidth = "100%";
  right.body.style.minWidth = "100%";

  const expected = new Map<HTMLElement, { top: number; left: number }>();
  const syncScroll = (source: HTMLElement, target: HTMLElement) => {
    const pending = expected.get(source);
    if (pending?.top === source.scrollTop && pending.left === source.scrollLeft) {
      expected.delete(source);
      return;
    }
    expected.delete(source);
    if (source.scrollTop !== target.scrollTop || source.scrollLeft !== target.scrollLeft) {
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
      expected.set(target, { top: target.scrollTop, left: target.scrollLeft });
    }
  };
  left.scroll.addEventListener("scroll", () => syncScroll(left.scroll, right.scroll), { passive: true });
  right.scroll.addEventListener("scroll", () => syncScroll(right.scroll, left.scroll), { passive: true });

  const changes = rows.map((row, index) => row.kind !== "equal" && (index === 0 || rows[index - 1].kind === "equal") ? index : -1).filter((index) => index >= 0);
  const expanded = new Set<number>();
  const changeElements = new Map<number, [HTMLElement, HTMLElement]>();
  let showAll = false;
  let activeChange = -1;
  previous.disabled = next.disabled = changes.length === 0;
  position.setText(`${changes.length} change${changes.length === 1 ? "" : "s"}`);

  const renderLine = (body: HTMLElement, row: SplitDiffRow, side: "left" | "right") => {
    const number = side === "left" ? row.leftNumber : row.rightNumber;
    const text = side === "left" ? row.leftText : row.rightText;
    const segments = side === "left" ? row.leftSegments : row.rightSegments;
    const kind = number === undefined ? "spacer" : row.kind === "equal" ? "equal" : side === "left" ? "delete" : "insert";
    const line = body.createDiv({ cls: `sink-diff-row sink-diff-${kind}` });
    const gutter = line.createDiv({ cls: "sink-diff-gutter" });
    gutter.setAttribute("aria-hidden", "true");
    gutter.createSpan({ cls: "sink-diff-line-number", text: number ?? "" });
    gutter.createSpan({ cls: "sink-diff-line-marker", text: kind === "delete" ? "−" : kind === "insert" ? "+" : "" });
    const content = line.createDiv({ cls: "sink-diff-line-text" });
    if (segments?.length) {
      for (const segment of segments) content.createSpan({ cls: segment.changed ? "sink-diff-word-change" : "", text: segment.text });
    } else content.setText(text ?? "");
    return line;
  };

  const renderRows = () => {
    const scrollTop = left.scroll.scrollTop;
    left.body.empty();
    right.body.empty();
    left.body.style.width = right.body.style.width = "";
    changeElements.clear();
    for (const entry of buildDiffDisplayRows(rows, expanded, showAll)) {
      if (entry.kind === "fold") {
        for (const body of [left.body, right.body]) {
          const fold = body.createEl("button", { cls: "sink-diff-fold", text: `··· ${entry.count} unchanged lines — expand` });
          fold.setAttribute("aria-expanded", "false");
          fold.addEventListener("click", () => { expanded.add(entry.start); renderRows(); });
        }
      } else {
        const pair: [HTMLElement, HTMLElement] = [renderLine(left.body, entry.row, "left"), renderLine(right.body, entry.row, "right")];
        if (changes.includes(entry.index)) changeElements.set(entry.index, pair);
        if (entry.index === changes[activeChange]) pair.forEach((line) => line.addClass("sink-diff-current-change"));
      }
    }
    const measuredWidth = Math.max(left.body.scrollWidth, right.body.scrollWidth);
    // A hidden modal has no layout yet; use a conservative ch-based width there.
    left.body.style.width = right.body.style.width = measuredWidth ? `${measuredWidth}px` : width;
    left.scroll.scrollTop = right.scroll.scrollTop = scrollTop;
  };

  contextButton.addEventListener("click", () => {
    showAll = !showAll;
    contextButton.setText(showAll ? "Collapse unchanged" : "Show all lines");
    contextButton.setAttribute("aria-pressed", String(showAll));
    renderRows();
  });
  const navigate = (direction: number) => {
    if (changes.length === 0) return;
    const old = changeElements.get(changes[activeChange]);
    old?.forEach((line) => line.removeClass("sink-diff-current-change"));
    activeChange = activeChange < 0 ? (direction > 0 ? 0 : changes.length - 1) : (activeChange + direction + changes.length) % changes.length;
    const pair = changeElements.get(changes[activeChange]);
    pair?.forEach((line) => line.addClass("sink-diff-current-change"));
    if (pair) left.scroll.scrollTop = right.scroll.scrollTop = Math.max(0, pair[0].offsetTop - 24);
    position.setText(`${activeChange + 1} / ${changes.length} changes`);
  };
  previous.addEventListener("click", () => navigate(-1));
  next.addEventListener("click", () => navigate(1));
  renderRows();
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
    if (subtitle) contentEl.createEl("p", { text: subtitle, cls: "setting-item-description" });
    renderSplitDiff(contentEl, leftLabel, rightLabel, leftText, rightText);
  };
  modal.onClose = () => modal.contentEl.empty();
  modal.open();
}