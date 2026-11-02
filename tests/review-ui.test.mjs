import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";

// Targeted UI regressions. These execute the real TS classes with a small
// Obsidian substitute and never read a live vault, settings, or credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const cache = new Map();
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
// The UI code reads window.confirm at apply time. Destructive applies ask for
// confirmation; tests default to accepting and stub refusals per case.
globalThis.window = window;
window.confirm = () => true;
const { document, HTMLElement } = window;
const proto = HTMLElement.prototype;

proto.createEl = function (tag, options = {}) {
  const el = document.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text !== undefined) el.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
  this.append(el);
  return el;
};
proto.createDiv = function (options) { return this.createEl("div", options); };
proto.createSpan = function (options) { return this.createEl("span", options); };
proto.setText = function (text) { this.textContent = text; };
proto.empty = function () { this.replaceChildren(); };
proto.addClass = function (...names) { this.classList.add(...names); };
proto.removeClass = function (...names) { this.classList.remove(...names); };
proto.toggleClass = function (name, active) { this.classList.toggle(name, active); };

const style = document.createElement("style");
style.textContent = readFileSync(path.join(root, "styles.css"), "utf8");
document.head.append(style);

class App {}
class Modal {
  constructor(app) {
    this.app = app;
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal";
    this.contentEl = document.createElement("div");
    this.modalEl.append(this.contentEl);
  }
  open() {
    document.body.append(this.modalEl);
    this.onOpen?.();
  }
  close() {
    this.onClose?.();
    this.modalEl.remove();
  }
}
const obsidian = { App, Modal, Setting: class {} };

function loadTS(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const { code } = transformSync(readFileSync(filename, "utf8"), { loader: "ts", format: "cjs", target: "es2020" });
  const require = (specifier) => {
    if (specifier === "obsidian") return obsidian;
    if (specifier.startsWith(".")) {
      return loadTS(path.relative(root, path.resolve(path.dirname(filename), `${specifier}.ts`)));
    }
    return nodeRequire(specifier);
  };
  new Function("require", "module", "exports", code)(require, module, module.exports);
  return module.exports;
}

const { BatchReviewModal } = loadTS("src/ui/BatchReviewModal.ts");
const { ConflictModal } = loadTS("src/ui/ConflictModal.ts");
const { renderSplitDiff } = loadTS("src/ui/DiffView.ts");

const app = new App();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const event = (name) => new window.Event(name, { bubbles: true });

function change(filePath, overrides = {}) {
  return {
    path: filePath,
    sourceDevice: "laptop",
    remoteMtime: 1700000000000,
    localMtime: 1700000001000,
    remoteDeleted: false,
    localExists: true,
    localContent: `local ${filePath}`,
    remoteContent: `remote ${filePath}`,
    isBinary: false,
    suggested: "keep-remote",
    ...overrides,
  };
}

function openBatch(changes, title = "Review sync operation") {
  const results = [];
  const modal = new BatchReviewModal(app, title, changes, (result) => results.push(result));
  modal.open();
  return { modal, results };
}

function openRow(modal, index = 0) {
  const row = rows(modal)[index];
  row.click();
  return row;
}

function rows(modal) {
  return [...modal.contentEl.querySelectorAll(".sink-review-file-row")];
}

function buttonByText(container, text) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === text);
}

function setCheckbox(checkbox, checked) {
  checkbox.checked = checked;
  checkbox.dispatchEvent(event("change"));
}

function choose(select, value) {
  select.value = value;
  select.dispatchEvent(event("change"));
}

test("paged file list caps DOM rows and keeps selection and decisions across pages", () => {
  const changes = Array.from({ length: 120 }, (_, index) => change(`note-${index}.md`));
  const { modal } = openBatch(changes);
  const pageStatus = () => modal.contentEl.querySelector(".sink-review-page-status").textContent;

  assert.equal(rows(modal).length, 25);
  assert.match(pageStatus(), /Page 1 of 5/);
  assert.match(pageStatus(), /1-25 of 120/);

  const firstRow = rows(modal)[0];
  setCheckbox(firstRow.querySelector(".sink-review-file-select"), false);
  choose(firstRow.querySelector(".sink-review-decision"), "keep-local");
  assert.match(modal.contentEl.querySelector(".sink-review-selection-count").textContent, /119 of 120 applicable/);

  const list = modal.contentEl.querySelector(".sink-review-file-list");
  list.scrollTop = 42;
  choose(modal.contentEl.querySelector(".sink-review-bulk-select"), "keep-remote");
  assert.equal(list.scrollTop, 42);
  assert.equal(rows(modal)[0].querySelector(".sink-review-decision").value, "keep-local");

  buttonByText(modal.contentEl, "Next").click();
  assert.equal(rows(modal).length, 25);
  assert.match(pageStatus(), /Page 2 of 5/);
  assert.equal(rows(modal)[0].textContent.includes("note-25.md"), true);
  assert.equal(modal.contentEl.querySelector(".sink-review-preview-header h3").textContent, "note-25.md");
  assert.equal(rows(modal)[0].querySelector(".sink-review-file-path").getAttribute("aria-current"), "true");

  buttonByText(modal.contentEl, "Previous").click();
  assert.match(pageStatus(), /Page 1 of 5/);
  assert.equal(modal.contentEl.querySelector(".sink-review-preview-header h3").textContent, "note-0.md");
  assert.equal(rows(modal)[0].querySelector(".sink-review-file-select").checked, false);
  assert.equal(rows(modal)[0].querySelector(".sink-review-decision").value, "keep-local");
});

test("apply returns choices from every page once and prevents double submission", () => {
  const changes = Array.from({ length: 30 }, (_, index) => change(`note-${index}.md`));
  const { modal, results } = openBatch(changes);

  choose(rows(modal)[0].querySelector(".sink-review-decision"), "keep-local");
  buttonByText(modal.contentEl, "Next").click();
  choose(rows(modal)[0].querySelector(".sink-review-decision"), "skip");
  setCheckbox(rows(modal)[1].querySelector(".sink-review-file-select"), false);

  const apply = buttonByText(modal.contentEl, "Apply selected");
  apply.click();
  apply.click();

  assert.equal(results.length, 1);
  assert.equal(results[0].approved, true);
  const decisions = new Map(results[0].decisions.map((decision) => [decision.path, decision]));
  assert.equal(decisions.get("note-0.md").decision, "keep-local");
  assert.equal(decisions.get("note-25.md").decision, "skip");
  assert.equal(decisions.get("note-26.md").selected, false);
  assert.equal(decisions.get("note-26.md").decision, "skip");
});

test("cancel resolves false exactly once", () => {
  const { modal, results } = openBatch([change("note.md")]);
  const cancel = buttonByText(modal.contentEl, "Cancel");
  cancel.click();
  cancel.click();
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { approved: false, decisions: [] });
});

test("the diff starts closed and clicking anywhere in a file row opens it", async () => {
  const first = change("closed.md");
  const { modal } = openBatch([first]);
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /Open a file row/);
  assert.equal(modal.contentEl.querySelectorAll(".sink-diff-pane").length, 0);

  const row = rows(modal)[0];
  row.querySelector(".sink-review-file-meta").click();
  assert.equal(modal.contentEl.querySelectorAll(".sink-diff-pane").length, 2);
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /local closed\.md/);
});

test("closing while a preview loads cancels once and ignores late data", async () => {
  let resolveLoad;
  const pending = change("late.md", {
    localContent: undefined,
    remoteContent: undefined,
    loadPreview: () => new Promise((resolve) => { resolveLoad = resolve; }),
  });
  const { modal, results } = openBatch([pending]);
  openRow(modal);
  buttonByText(modal.contentEl, "Cancel").click();
  assert.equal(results.length, 1);
  assert.equal(results[0].approved, false);

  resolveLoad({ localContent: "late local", remoteContent: "late server" });
  await settle();
  assert.equal(modal.contentEl.textContent, "");
  assert.equal(results.length, 1);
});

test("apply is disabled and explained when nothing effective is selected", () => {
  const { modal, results } = openBatch([change("only.md")]);
  const select = rows(modal)[0].querySelector(".sink-review-decision");
  const apply = buttonByText(modal.contentEl, "Apply selected");

  choose(select, "skip");
  assert.equal(apply.disabled, true);
  assert.equal(window.getComputedStyle(apply).opacity, "0.5");
  const previous = buttonByText(modal.contentEl, "Previous");
  assert.equal(previous.disabled, true);
  assert.equal(window.getComputedStyle(previous).opacity, "0.5");
  assert.match(modal.contentEl.querySelector(".sink-review-footer-note").textContent, /No file has an applicable decision/);
  apply.click();
  assert.equal(results.length, 0);

  choose(select, "keep-remote");
  assert.equal(apply.disabled, false);
  apply.click();
  assert.equal(results.length, 1);
  assert.equal(results[0].decisions[0].decision, "keep-remote");
});

test("dialog and consequence expose accessible labels and live updates", () => {
  const { modal } = openBatch([change("announce.md")]);
  const titleId = modal.contentEl.querySelector("h2").id;
  assert.equal(modal.contentEl.getAttribute("aria-labelledby"), titleId);
  assert.equal(modal.modalEl.getAttribute("aria-labelledby"), titleId);

  const consequence = modal.contentEl.querySelector(".sink-review-consequence");
  assert.equal(consequence.getAttribute("aria-live"), "polite");
  choose(rows(modal)[0].querySelector(".sink-review-decision"), "keep-local");
  assert.match(consequence.textContent, /publishes this vault's contents/);
});

test("preview loader ignores a stale result after selecting another file", async () => {
  let resolveFirst;
  const first = change("a.md", {
    localContent: undefined,
    remoteContent: undefined,
    loadPreview: () => new Promise((resolve) => { resolveFirst = resolve; }),
  });
  const second = change("b.md", { localContent: "second local", remoteContent: "second server" });
  const { modal } = openBatch([first, second]);
  openRow(modal);

  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /Loading preview/);
  buttonByText(modal.contentEl, "b.md").click();
  await settle();
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /second local/);

  resolveFirst({ localContent: "stale local", remoteContent: "stale server" });
  await settle();
  const preview = modal.contentEl.querySelector(".sink-review-preview-content").textContent;
  assert.equal(preview.includes("stale local"), false);
  assert.match(preview, /second server/);
});

test("preview loader failure is reported and falls back to provided content", async () => {
  const failed = change("c.md", {
    localContent: "fallback local",
    remoteContent: "fallback server",
    loadPreview: () => Promise.reject(new Error("boom")),
  });
  const { modal } = openBatch([failed]);
  openRow(modal);
  await settle();

  const preview = modal.contentEl.querySelector(".sink-review-preview-content");
  assert.match(preview.textContent, /Preview could not be loaded: boom/);
  assert.match(preview.textContent, /fallback local/);
  assert.match(preview.textContent, /fallback server/);
  const retry = buttonByText(preview, "Retry preview");
  assert.equal(retry !== undefined, true);
  assert.equal(retry.classList.contains("sink-review-retry"), true);
});

test("loader errors without provided content still leave the review usable", async () => {
  const failed = change("d.md", {
    localContent: undefined,
    remoteContent: undefined,
    loadPreview: () => Promise.reject(new Error("no preview")),
  });
  const { modal, results } = openBatch([failed]);
  openRow(modal);
  await settle();

  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /no preview/);
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results.length, 1);
  assert.equal(results[0].decisions[0].path, "d.md");
});

test("binary files use an explicit fallback without invoking the loader", () => {
  let called = false;
  const binary = change("image.png", {
    isBinary: true,
    localContent: "",
    remoteContent: "",
    loadPreview: async () => { called = true; return { localContent: "x", remoteContent: "y" }; },
  });
  const { modal } = openBatch([binary]);
  openRow(modal);
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /Binary file/);
  assert.equal(called, false);
});

test("oversized text preview is refused with a clear fallback", () => {
  const large = change("large.md", {
    localContent: "a".repeat(600000),
    remoteContent: "b".repeat(600000),
  });
  const { modal } = openBatch([large]);
  openRow(modal);
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /Preview omitted for safety/);
});

test("merge is never offered or emitted without a true common ancestor", () => {
  const merged = change("conflicted.md", { suggested: "merge" });
  const { modal, results } = openBatch([merged]);
  const values = [...modal.contentEl.querySelectorAll(".sink-review-decision option")].map((option) => option.value);
  assert.deepEqual(values, ["keep-local", "keep-remote", "skip"]);
  assert.equal(modal.contentEl.textContent.toLowerCase().includes("merge"), false);
  assert.equal(rows(modal)[0].querySelector(".sink-review-decision").value, "skip");

  const apply = buttonByText(modal.contentEl, "Apply selected");
  assert.equal(apply.disabled, true);
  assert.match(modal.contentEl.querySelector(".sink-review-footer-note").textContent, /No file has an applicable decision/);
  apply.click();
  assert.equal(results.length, 0);

  choose(rows(modal)[0].querySelector(".sink-review-decision"), "keep-local");
  apply.click();
  assert.equal(results[0].decisions[0].decision, "keep-local");
});

test("conflict modal uses this-device and server sides with real choices only", () => {
  const choices = [];
  const modal = new ConflictModal(app, "conflicted.md", "device text", "server text", (choice) => choices.push(choice));
  modal.open();

  const text = modal.contentEl.textContent;
  assert.match(text, /Local/);
  assert.match(text, /Remote/);
  assert.match(text, /device text/);
  assert.match(text, /server text/);
  assert.equal(text.toLowerCase().includes("merge"), false);
  assert.equal(modal.contentEl.querySelectorAll(".sink-diff-pane").length, 2);
  assert.equal(modal.modalEl.getAttribute("aria-labelledby"), modal.contentEl.querySelector("h2").id);

  const keepThisDevice = modal.contentEl.querySelector(".sink-conflict-choice-mine");
  const keepServer = modal.contentEl.querySelector(".sink-conflict-choice-theirs");
  assert.equal(keepServer.classList.contains("mod-cta"), false);
  assert.equal(document.activeElement, keepThisDevice);
  keepThisDevice.click();
  keepServer.click();
  assert.deepEqual(choices, ["mine"]);
});

test("conflict modal can leave both unchanged without a callback", () => {
  const choices = [];
  const modal = new ConflictModal(app, "leave.md", "device text", "server text", (choice) => choices.push(choice));
  modal.open();
  const leave = modal.contentEl.querySelector(".sink-conflict-choice-leave");
  assert.ok(leave);
  assert.equal(leave.textContent, "Leave both as they are");
  leave.click();
  assert.deepEqual(choices, []);
  assert.equal(modal.contentEl.textContent, "");
});

test("blocked database revisions start unselected, report a blocked count, and are never applied", () => {
  const { modal, results } = openBatch([change("blocked.md", { blockedReason: "Blocked: retained database revisions require resolution." })]);
  assert.match(modal.contentEl.textContent, /Blocked: retained database revisions/);
  assert.equal(modal.contentEl.querySelector(".sink-review-decision").disabled, true);
  const checkbox = modal.contentEl.querySelector(".sink-review-file-select");
  assert.equal(checkbox.disabled, true);
  assert.equal(checkbox.checked, false);
  const summary = modal.contentEl.querySelector(".sink-review-selection-count").textContent;
  assert.match(summary, /0 of 0 applicable/);
  assert.match(summary, /1 blocked/);
  assert.match(modal.contentEl.querySelector(".sink-review-footer-note").textContent, /No file has an applicable decision/);

  buttonByText(modal.contentEl, "Select all").click();
  assert.equal(modal.contentEl.querySelector(".sink-review-file-select").checked, false);
  assert.match(modal.contentEl.querySelector(".sink-review-selection-count").textContent, /0 of 0 applicable/);

  const bulk = modal.contentEl.querySelector(".sink-review-bulk-select");
  bulk.value = "keep-remote";
  bulk.dispatchEvent(event("change"));
  assert.equal(modal.contentEl.querySelector(".sink-review-apply").disabled, true);
  assert.deepEqual(results, []);
  modal.close();
});

test("bulk decisions report the selected files they had to skip and why", () => {
  const available = change("available.md");
  const blocked = change("blocked.md", { blockedReason: "Blocked: retained database revisions require resolution." });
  const bothMissing = change("both-missing.md", {
    remoteExists: false,
    localExists: false,
    localContent: undefined,
    localMtime: undefined,
    remoteContent: undefined,
    remoteDeleted: false,
    suggested: "keep-local",
  });
  const { modal } = openBatch([available, blocked, bothMissing]);
  assert.match(modal.contentEl.querySelector(".sink-review-selection-count").textContent, /2 selected • 1 applicable/);

  choose(modal.contentEl.querySelector(".sink-review-bulk-select"), "keep-local");
  const notice = modal.contentEl.querySelector(".sink-review-bulk-note");
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /Bulk Local skipped 1 file/);
  assert.match(notice.textContent, /1 without a Local option/);
  assert.equal(rows(modal)[0].querySelector(".sink-review-decision").value, "keep-local");
  assert.equal(rows(modal)[1].querySelector(".sink-review-decision").value, "skip");
  assert.equal(rows(modal)[2].querySelector(".sink-review-decision").value, "skip");

  setCheckbox(rows(modal)[0].querySelector(".sink-review-file-select"), false);
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, "");
});

test("apply footer summarizes effective sides and deletions", () => {
  const publish = change("publish.md");
  const adopt = change("adopt.md");
  const { modal } = openBatch([publish, adopt]);
  choose(rows(modal)[0].querySelector(".sink-review-decision"), "keep-local");
  choose(rows(modal)[1].querySelector(".sink-review-decision"), "keep-remote");
  const note = modal.contentEl.querySelector(".sink-review-footer-note").textContent;
  assert.match(note, /Apply 2 files: Local 1, Remote 1/);
  assert.equal(note.includes("Deletes"), false);
});

test("only destructive applies ask for confirmation and a refusal applies nothing", () => {
  const remoteOnly = change("remote-only.md", {
    localExists: false,
    localContent: undefined,
    localMtime: undefined,
    suggested: "keep-remote",
  });
  const { modal, results } = openBatch([remoteOnly]);
  choose(rows(modal)[0].querySelector(".sink-review-decision"), "keep-local");
  assert.match(modal.contentEl.querySelector(".sink-review-footer-note").textContent, /Deletes 1 file in the database \(Local\)/);

  const calls = [];
  const original = window.confirm;
  window.confirm = (message) => { calls.push(message); return false; };
  try {
    buttonByText(modal.contentEl, "Apply selected").click();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /deletes 1 file in the database \(Local\)/);
    assert.deepEqual(results, []);

    window.confirm = (message) => { calls.push(message); return true; };
    buttonByText(modal.contentEl, "Apply selected").click();
    assert.equal(results.length, 1);
    assert.equal(results[0].approved, true);
  } finally {
    window.confirm = original;
  }
});

test("remote deletions are summarized and confirmed too", () => {
  const deleted = change("deleted.md", {
    remoteDeleted: true,
    suggested: "keep-remote",
  });
  const { modal, results } = openBatch([deleted]);
  choose(rows(modal)[0].querySelector(".sink-review-decision"), "keep-remote");
  assert.match(modal.contentEl.querySelector(".sink-review-footer-note").textContent, /Deletes 1 file in this vault \(Remote\)/);

  const original = window.confirm;
  let calls = 0;
  window.confirm = () => { calls++; return false; };
  try {
    buttonByText(modal.contentEl, "Apply selected").click();
    assert.equal(calls, 1);
    assert.deepEqual(results, []);
  } finally {
    window.confirm = original;
  }
});

test("opening a file name keeps focus on the row and Escape restores it from the preview", () => {
  const { modal } = openBatch([change("focus.md")]);
  const pathButton = buttonByText(modal.contentEl, "focus.md");
  const previewHeading = () => modal.contentEl.querySelector(".sink-review-preview-header h3");

  pathButton.click();
  assert.equal(modal.contentEl.querySelectorAll(".sink-diff-pane").length, 2);
  assert.notEqual(document.activeElement, previewHeading());

  const scroll = modal.contentEl.querySelector(".sink-diff-scroll");
  scroll.focus();
  assert.equal(document.activeElement, scroll);
  scroll.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.activeElement, pathButton);
});

test("conflict modal can choose the server side once", () => {
  const choices = [];
  const modal = new ConflictModal(app, "other.md", "", "", (choice) => choices.push(choice));
  modal.open();
  assert.match(modal.contentEl.textContent, /No text preview is available/);
  modal.contentEl.querySelector(".sink-conflict-choice-theirs").click();
  assert.deepEqual(choices, ["theirs"]);
});

function revision(rev, overrides = {}) {
  return {
    rev,
    mtime: 1700000000000,
    deleted: false,
    isBinary: false,
    size: 42,
    deviceName: "desktop",
    deviceId: "device-desktop",
    ...overrides,
  };
}

function conflictChange(filePath, overrides = {}) {
  return change(filePath, {
    suggested: "keep-remote",
    conflictRevision: "2-winner",
    conflictRevisions: [
      revision("2-winner"),
      revision("3-other", { deviceName: "tablet", mtime: 1700000002000 }),
      revision("4-deleted", { deleted: true, deviceName: "phone", mtime: 1700000003000 }),
    ],
    ...overrides,
  });
}

test("retained conflict rows expose a server revision selector defaulting to the current winner", async () => {
  const calls = [];
  const conflicted = conflictChange("database.md", {
    loadConflictPreview: async (rev) => {
      calls.push(rev);
      return { localContent: "device database", remoteContent: `server ${rev}` };
    },
  });
  const { modal } = openBatch([conflicted]);
  openRow(modal);
  await settle();

  const row = rows(modal)[0];
  assert.match(row.querySelector(".sink-review-file-meta").textContent, /3 remote revisions retained/);
  const select = row.ownerDocument.querySelector(".sink-review-revision-select");
  assert.ok(select);
  assert.equal(select.value, "2-winner");
  assert.equal(select.disabled, false);
  assert.match(select.textContent, /2-winner/);
  assert.match(select.textContent, /deleted/);
  assert.match(select.textContent, /tablet/);
  assert.deepEqual(calls, ["2-winner"]);
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /server 2-winner/);
  const values = [...row.querySelectorAll(".sink-review-decision option")].map((option) => option.value);
  assert.deepEqual(values, ["keep-local", "keep-remote", "skip"]);
  assert.equal(modal.contentEl.textContent.toLowerCase().includes("merge"), false);
});

test("a binary retained-conflict row never renders a false empty diff and still maps the selected revision", () => {
  const conflicted = conflictChange("image.png", { isBinary: true });
  const { modal, results } = openBatch([conflicted]);
  openRow(modal);
  const preview = modal.contentEl.querySelector(".sink-review-preview-content").textContent;
  assert.match(preview, /Binary file/);
  assert.equal(preview.includes("No differences"), false);
  assert.equal(modal.contentEl.querySelectorAll(".sink-diff-pane").length, 0);
  const select = modal.contentEl.querySelector(".sink-review-revision-select");
  assert.ok(select);
  choose(select, "3-other");
  assert.match(modal.contentEl.querySelector(".sink-review-consequence").textContent, /remote revision 3-other/);
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results[0].decisions[0].conflictRevision, "3-other");
});

test("selecting another retained leaf loads it and emits that revision on apply", async () => {
  const calls = [];
  const conflicted = conflictChange("database.md", {
    loadConflictPreview: async (rev) => {
      calls.push(rev);
      return { localContent: "device database", remoteContent: `server ${rev}` };
    },
  });
  const { modal, results } = openBatch([conflicted]);
  openRow(modal);
  await settle();

  const select = modal.contentEl.querySelector(".sink-review-revision-select");
  choose(select, "3-other");
  await settle();
  assert.deepEqual(calls, ["2-winner", "3-other"]);
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /server 3-other/);

  choose(rows(modal)[0].querySelector(".sink-review-decision"), "keep-remote");
  assert.match(modal.contentEl.querySelector(".sink-review-consequence").textContent, /adopting remote revision 3-other/);
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results.length, 1);
  assert.equal(results[0].decisions[0].decision, "keep-remote");
  assert.equal(results[0].decisions[0].conflictRevision, "3-other");
});

test("conflict leaf loading ignores a stale response and reports failures", async () => {
  let resolveFirst;
  const racing = conflictChange("race.md", {
    loadConflictPreview: (rev) => rev === "2-winner"
      ? new Promise((resolve) => { resolveFirst = resolve; })
      : Promise.resolve({ localContent: "RACE LOCAL", remoteContent: "RACE SECOND" }),
  });
  const { modal } = openBatch([racing]);
  openRow(modal);
  const select = modal.contentEl.querySelector(".sink-review-revision-select");
  choose(select, "3-other");
  await settle();
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /RACE SECOND/);

  resolveFirst({ localContent: "RACE LOCAL", remoteContent: "RACE STALE" });
  await settle();
  const preview = modal.contentEl.querySelector(".sink-review-preview-content").textContent;
  assert.equal(preview.includes("RACE STALE"), false);
  assert.match(preview, /RACE SECOND/);

  const failing = conflictChange("fail.md", {
    loadConflictPreview: () => Promise.reject(new Error("leaf boom")),
  });
  const failed = openBatch([failing]);
  openRow(failed.modal);
  await settle();
  const failedPreview = failed.modal.contentEl.querySelector(".sink-review-preview-content");
  assert.match(failedPreview.textContent, /Remote revision could not be loaded: leaf boom/);
  assert.ok(buttonByText(failedPreview, "Retry remote revision"));
  assert.equal(failed.modal.contentEl.querySelector(".sink-review-decision").disabled, false);
});

test("conflict rows without a leaf loader show metadata and never a false diff", () => {
  const conflicted = conflictChange("no-loader.md", {
    localContent: "FALSE LOCAL",
    remoteContent: "FALSE SERVER",
  });
  const { modal, results } = openBatch([conflicted]);
  openRow(modal);
  const preview = modal.contentEl.querySelector(".sink-review-preview-content").textContent;
  assert.match(preview, /3 remote revisions retained/);
  assert.match(preview, /not available in this review/);
  assert.equal(preview.includes("FALSE LOCAL"), false);
  assert.equal(preview.includes("FALSE SERVER"), false);

  choose(modal.contentEl.querySelector(".sink-review-decision"), "keep-remote");
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results[0].decisions[0].conflictRevision, "2-winner");
});

test("a per-row Local then Remote switch preserves the diff revision", () => {
  const conflicted = conflictChange("switch.md", {
    loadConflictPreview: async (rev) => ({ localContent: "local", remoteContent: `server ${rev}` }),
  });
  const { modal, results } = openBatch([conflicted]);
  openRow(modal);
  const select = modal.contentEl.querySelector(".sink-review-revision-select");
  choose(select, "3-other");
  const decision = rows(modal)[0].querySelector(".sink-review-decision");
  choose(decision, "keep-local");
  choose(decision, "keep-remote");
  assert.equal(modal.contentEl.querySelector(".sink-review-revision-select").value, "3-other");
  assert.match(modal.contentEl.querySelector(".sink-review-consequence").textContent, /remote revision 3-other/);
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results[0].decisions[0].conflictRevision, "3-other");
});

test("switching Local then Remote preserves the revision shown in the diff", () => {
  const first = conflictChange("first.md", {
    loadConflictPreview: async (rev) => ({ localContent: "local", remoteContent: `server ${rev}` }),
  });
  const second = conflictChange("second.md", {
    loadConflictPreview: async (rev) => ({ localContent: "local", remoteContent: `server ${rev}` }),
  });
  const { modal, results } = openBatch([first, second]);
  openRow(modal);
  choose(modal.contentEl.querySelector(".sink-review-revision-select"), "3-other");
  choose(modal.contentEl.querySelector(".sink-review-bulk-select"), "keep-local");
  choose(modal.contentEl.querySelector(".sink-review-bulk-select"), "keep-remote");
  assert.equal(rows(modal)[0].querySelector(".sink-review-decision").value, "keep-remote");
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results[0].decisions[0].conflictRevision, "3-other");
});

test("bulk keep-remote retains each row's selected revision or its default", async () => {
  const first = conflictChange("first.md", {
    loadConflictPreview: async (rev) => ({ localContent: "local", remoteContent: `server ${rev}` }),
  });
  const second = conflictChange("second.md", {
    loadConflictPreview: async (rev) => ({ localContent: "local", remoteContent: `server ${rev}` }),
  });
  const { modal, results } = openBatch([first, second]);
  buttonByText(modal.contentEl, "second.md").click();
  await settle();
  choose(modal.contentEl.querySelector(".sink-review-revision-select"), "3-other");
  choose(modal.contentEl.querySelector(".sink-review-bulk-select"), "keep-remote");
  buttonByText(modal.contentEl, "Apply selected").click();
  const decisions = new Map(results[0].decisions.map((decision) => [decision.path, decision]));
  assert.equal(decisions.get("first.md").conflictRevision, "2-winner");
  assert.equal(decisions.get("second.md").conflictRevision, "3-other");
});

test("keep-local emits no retained revision and bulk keep-local clears prior selections", async () => {
  const conflicted = conflictChange("keep-local.md", {
    loadConflictPreview: async (rev) => ({ localContent: "local", remoteContent: `server ${rev}` }),
  });
  const { modal, results } = openBatch([conflicted]);
  openRow(modal);
  await settle();
  choose(modal.contentEl.querySelector(".sink-review-revision-select"), "3-other");
  choose(modal.contentEl.querySelector(".sink-review-bulk-select"), "keep-local");
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results[0].decisions[0].decision, "keep-local");
  assert.equal("conflictRevision" in results[0].decisions[0], false);
});

test("only an engine blocked reason disables retained conflict rows", () => {
  const blocked = conflictChange("blocked-db.md", {
    blockedReason: "Blocked: retained database revisions require resolution.",
  });
  const { modal, results } = openBatch([blocked]);
  openRow(modal);
  assert.equal(modal.contentEl.querySelector(".sink-review-revision-select").disabled, true);
  assert.equal(modal.contentEl.querySelector(".sink-review-decision").disabled, true);
  assert.equal(modal.contentEl.querySelector(".sink-review-file-select").disabled, true);
  assert.equal(buttonByText(modal.contentEl, "Apply selected").disabled, true);
  assert.deepEqual(results, []);
});

test("conflict modal accepts optional revisions and loads the selected server leaf", async () => {
  const calls = [];
  const choices = [];
  const options = {
    conflictRevision: "2-winner",
    conflictRevisions: [revision("2-winner"), revision("3-other")],
    loadConflictPreview: async (rev) => {
      calls.push(rev);
      return { localContent: "modal local", remoteContent: `modal server ${rev}` };
    },
  };
  const modal = new ConflictModal(
    app,
    "db-conflict.md",
    "modal local",
    "modal server 2-winner",
    (choice) => choices.push(choice),
    options
  );
  modal.open();
  const select = modal.contentEl.querySelector(".sink-conflict-revision-select");
  assert.ok(select);
  assert.equal(select.value, "2-winner");
  assert.deepEqual(calls, ["2-winner"]);

  choose(select, "3-other");
  await settle();
  assert.deepEqual(calls, ["2-winner", "3-other"]);
  assert.match(modal.contentEl.querySelector(".sink-conflict-preview").textContent, /modal server 3-other/);
  assert.equal(modal.contentEl.textContent.toLowerCase().includes("merge"), false);

  modal.contentEl.querySelector(".sink-conflict-choice-theirs").click();
  assert.deepEqual(choices, ["theirs"]);
});

test("a selected non-default revision is returned with the conflict choice", async () => {
  const choices = [];
  const modal = new ConflictModal(
    app,
    "mapped.md",
    "local",
    "server",
    (choice, revision) => choices.push({ choice, revision }),
    { conflictRevisions: [revision("2-winner"), revision("3-other")], conflictRevision: "2-winner" }
  );
  modal.open();
  choose(modal.contentEl.querySelector(".sink-conflict-revision-select"), "3-other");
  modal.contentEl.querySelector(".sink-conflict-choice-theirs").click();
  assert.deepEqual(choices, [{ choice: "theirs", revision: "3-other" }]);
});

test("an absent server version is never described as a deletion and keep-server leaves the local file alone", () => {
  const onlyLocal = change("only-local.md", {
    remoteExists: false,
    remoteDeleted: false,
    remoteMtime: 0,
    remoteContent: undefined,
    suggested: "keep-local",
  });
  const { modal, results } = openBatch([onlyLocal]);
  const row = openRow(modal);
  const meta = row.querySelector(".sink-review-file-meta").textContent;
  assert.match(meta, /Remote has no version/);
  assert.equal(meta.includes("Remote deleted this file"), false);
  assert.equal(meta.includes("Remote has a version"), false);
  assert.match(modal.contentEl.querySelector(".sink-review-preview-content").textContent, /remote has no version/i);

  const keepServerOption = [...row.querySelectorAll(".sink-review-decision option")]
    .find((option) => option.value === "keep-remote");
  assert.equal(keepServerOption.disabled, false);
  assert.match(keepServerOption.textContent, /Remote/);
  assert.match(keepServerOption.textContent, /no version/);

  choose(row.querySelector(".sink-review-decision"), "keep-remote");
  const consequence = modal.contentEl.querySelector(".sink-review-consequence").textContent;
  assert.match(consequence, /leaves the local file unchanged/);
  assert.match(consequence, /nothing is deleted or uploaded/);
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results[0].decisions[0].decision, "keep-remote");
});

test("a missing local file with a server version offers deletion and restore", () => {
  const onlyRemote = change("only-remote.md", {
    remoteExists: true,
    localExists: false,
    localContent: undefined,
    localMtime: undefined,
    suggested: "keep-remote",
  });
  const { modal, results } = openBatch([onlyRemote]);
  const row = rows(modal)[0];
  const select = row.querySelector(".sink-review-decision");
  const keepLocalOption = [...select.querySelectorAll("option")]
    .find((option) => option.value === "keep-local");
  assert.equal(keepLocalOption.disabled, false);
  assert.equal(keepLocalOption.textContent, "Local");

  choose(select, "keep-local");
  const consequence = modal.contentEl.querySelector(".sink-review-consequence").textContent;
  assert.match(consequence, /Local publishes a deletion/);
  assert.match(consequence, /remote copy of this file is deleted/);

  choose(select, "keep-remote");
  assert.match(modal.contentEl.querySelector(".sink-review-consequence").textContent, /Remote restores this file in the local vault/);

  choose(select, "keep-local");
  buttonByText(modal.contentEl, "Apply selected").click();
  assert.equal(results[0].decisions[0].decision, "keep-local");
});

test("a file absent on both sides is an explicit no-op with only skip usable", () => {
  const neither = change("neither.md", {
    remoteExists: false,
    localExists: false,
    localContent: undefined,
    localMtime: undefined,
    remoteContent: undefined,
    remoteDeleted: false,
    remoteMtime: 0,
    suggested: "keep-local",
  });
  const { modal, results } = openBatch([neither]);
  const row = rows(modal)[0];
  assert.match(row.querySelector(".sink-review-file-meta").textContent, /Not in the local vault/);
  const options = [...row.querySelectorAll(".sink-review-decision option")];
  assert.equal(options.find((option) => option.value === "keep-local").disabled, true);
  assert.equal(options.find((option) => option.value === "keep-remote").disabled, true);
  assert.equal(row.querySelector(".sink-review-decision").value, "skip");
  assert.match(modal.contentEl.querySelector(".sink-review-consequence").textContent, /missing both locally and remotely/i);
  assert.equal(buttonByText(modal.contentEl, "Apply selected").disabled, true);

  choose(row.querySelector(".sink-review-decision"), "keep-local");
  assert.equal(row.querySelector(".sink-review-decision").value, "skip");
  assert.equal(results.length, 0);
});

test("a deleted server version without a local file still disables keep-local", () => {
  const deleted = change("deleted.md", {
    remoteExists: true,
    remoteDeleted: true,
    localExists: false,
    localContent: undefined,
    localMtime: undefined,
    suggested: "keep-remote",
  });
  const { modal } = openBatch([deleted]);
  const select = modal.contentEl.querySelector(".sink-review-decision");
  const keepLocal = [...select.querySelectorAll("option")].find((option) => option.value === "keep-local");
  assert.equal(keepLocal.disabled, true);
  assert.equal(keepLocal.textContent, "Local (absent)");
  choose(select, "keep-remote");
  assert.match(modal.contentEl.querySelector(".sink-review-consequence").textContent, /deletes this file in the local vault/);
});

test("conflict modal retry names the remote revision load", async () => {
  const modal = new ConflictModal(
    app,
    "retry.md",
    "local",
    "server",
    () => {},
    {
      conflictRevisions: [revision("2-winner")],
      conflictRevision: "2-winner",
      loadConflictPreview: () => Promise.reject(new Error("revision boom")),
    }
  );
  modal.open();
  await settle();
  const preview = modal.contentEl.querySelector(".sink-conflict-preview");
  assert.match(preview.textContent, /Remote revision could not be loaded: revision boom/);
  const retry = buttonByText(preview, "Retry loading remote revision");
  assert.ok(retry);
  assert.equal(buttonByText(preview, "Retry server revision"), undefined);
});

function diffHarness(leftText, rightText) {
  const container = document.createElement("div");
  document.body.append(container);
  renderSplitDiff(container, "Local", "Remote", leftText, rightText);
  return container;
}

test("diff navigation reports 'Change 1 of 2' style positions", () => {
  const original = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const changed = [...original];
  changed[10] = "first edit";
  changed[30] = "second edit";
  const container = diffHarness(original.join("\n"), changed.join("\n"));
  try {
    const next = container.querySelector('[aria-label="Next change"]');
    const previous = container.querySelector('[aria-label="Previous change"]');
    const position = container.querySelector(".sink-diff-position");
    next.click();
    assert.equal(position.textContent, "Change 1 of 2");
    next.click();
    assert.equal(position.textContent, "Change 2 of 2");
    previous.click();
    assert.equal(position.textContent, "Change 1 of 2");
  } finally {
    container.remove();
  }
});

test("fold labels have no em dash and expanding restores focus to the first revealed row", () => {
  const original = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const changed = [...original];
  changed[10] = "first edit";
  changed[30] = "second edit";
  const container = diffHarness(original.join("\n"), changed.join("\n"));
  try {
    const fold = container.querySelector(".sink-diff-left .sink-diff-fold");
    assert.match(fold.textContent, /unchanged lines, expand/);
    assert.equal(fold.textContent.includes("—"), false);
    fold.click();

    const focused = document.activeElement;
    const leftPane = container.querySelector(".sink-diff-left");
    assert.ok(leftPane.contains(focused));
    assert.equal(focused.classList.contains("sink-diff-row"), true);
    assert.match(focused.textContent, /line 3/);
  } finally {
    container.remove();
  }
});
