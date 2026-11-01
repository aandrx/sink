import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";

// Focused snapshot UI regressions. These execute the real SettingsTab with a
// small Obsidian substitute and never read a live vault, settings, or credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const cache = new Map();
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
const { document, HTMLElement } = window;
const proto = HTMLElement.prototype;
globalThis.window = window;

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

const notices = [];
class Notice {
  constructor(message) {
    this.message = String(message);
    notices.push(this.message);
  }
}
class TFile {
  constructor(filePath) { this.path = filePath; }
}
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
  close() { this.modalEl.remove(); }
}

const obsidian = {
  App: class {},
  DropdownComponent: class {},
  Modal,
  Notice,
  PluginSettingTab: class {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
    }
  },
  Setting: class {},
  TFile,
};

function stub(relative, exports) {
  cache.set(path.resolve(root, relative), { exports });
}

stub("src/ui/DiffView.ts", { renderSplitDiff() {} });
stub("src/utils/uri.ts", { generateSetupURI: async () => "" });
stub("src/ui/SetupWizard.ts", { SetupWizard: class { open() {} } });

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

const { SinkSettingsTab } = loadTS("src/ui/SettingsTab.ts");

const settle = async (turns = 1) => {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const summary = (id, reason, createdAt) => ({ id, reason, createdAt, fileCount: 0 });
const detail = (id, reason, createdAt) => ({
  _id: `meta:snapshot:${id}`,
  _rev: "1",
  type: "meta",
  metaType: "snapshot",
  createdAt,
  reason,
  sourceDevice: "device",
  files: [],
});

function makeApp() {
  return {
    vault: {
      getAbstractFileByPath: () => null,
      read: async () => "",
      readBinary: async () => new ArrayBuffer(0),
    },
  };
}

function makeTab(engine) {
  const app = makeApp();
  const plugin = { getSyncEngine: () => engine };
  const tab = new SinkSettingsTab(app, plugin);
  const container = document.createElement("div");
  const info = document.createElement("p");
  return { app, tab, container, info };
}

test("snapshot list failures render a bounded error instead of rejecting", async () => {
  notices.length = 0;
  const { tab, container, info } = makeTab({
    listSnapshots: async () => { throw new Error("Snapshot is encrypted; a passphrase is required to read it"); },
  });

  await tab.renderSnapshots(container, info);
  assert.match(container.textContent, /Could not load restore points/);
  assert.match(container.textContent, /passphrase/);
  assert.ok(notices.some((message) => /Could not load restore points/.test(message)));
});

test("snapshot detail failures render an error and keep the selection usable", async () => {
  notices.length = 0;
  const { tab, container, info } = makeTab({
    listSnapshots: async () => [summary("new", "newer", 2)],
    getSnapshotDetails: async () => { throw new Error("Snapshot is encrypted; a passphrase is required to read it"); },
  });

  await tab.renderSnapshots(container, info);
  await settle(3);
  assert.match(container.textContent, /Could not load this restore point/);
  assert.match(container.textContent, /passphrase/);
  assert.ok(container.querySelector("select"));
});

test("a slower older selection cannot replace a newer selection", async () => {
  let resolveNew;
  let resolveOld;
  const { tab, container, info } = makeTab({
    listSnapshots: async () => [summary("new", "newer", 2), summary("old", "older", 1)],
    getSnapshotDetails: (id) => new Promise((resolve) => {
      if (id === "new") resolveNew = resolve;
      else resolveOld = resolve;
    }),
  });

  await tab.renderSnapshots(container, info);
  const select = container.querySelector("select");
  select.value = "old";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();

  assert.equal(typeof resolveNew, "function");
  assert.equal(typeof resolveOld, "function");

  resolveOld(detail("old", "older", 1));
  await settle(3);
  assert.match(container.querySelector(".sink-snapshot-details").textContent, /older/);

  resolveNew(detail("new", "newer", 2));
  await settle(3);
  assert.match(container.querySelector(".sink-snapshot-details").textContent, /older/);
  assert.doesNotMatch(container.querySelector(".sink-snapshot-details").textContent, /newer/);
});

test("restore is disabled while pending and reports a partial-apply warning on failure", async () => {
  notices.length = 0;
  let rejectRestore;
  const { tab, container, info } = makeTab({
    listSnapshots: async () => [summary("new", "newer", 2)],
    getSnapshotDetails: async () => detail("new", "newer", 2),
    restoreSnapshot: () => new Promise((resolve, reject) => { rejectRestore = reject; }),
  });

  window.confirm = () => true;
  await tab.renderSnapshots(container, info);
  await settle(3);

  const restore = [...container.querySelectorAll("button")].find((button) => button.textContent === "Restore snapshot");
  restore.click();
  assert.equal(restore.disabled, true);

  rejectRestore(new Error("snapshot decryption failed"));
  await settle(3);
  assert.equal(restore.disabled, false);
  assert.match(container.textContent, /Some files may already have been restored/);
  assert.ok(notices.some((message) => /Some files may already have been restored/.test(message)));
});

test("snapshot diff read failures are reported instead of rejecting", async () => {
  notices.length = 0;
  const { app, tab, container, info } = makeTab({});
  app.vault.getAbstractFileByPath = (filePath) => new TFile(filePath);
  app.vault.read = async () => { throw new Error("vault read failed"); };

  await tab.showSnapshotDiff(
    detail("new", "newer", 2),
    { path: "note.md", existed: true, isBinary: false, content: "old", mtime: 1, ctime: 1 }
  );
  assert.ok(notices.some((message) => /Could not open the snapshot diff/.test(message)));
  assert.equal(container.textContent, "");
});

test("binary snapshot files are compared one at a time", async () => {
  const { app, tab } = makeTab({});
  let reads = 0;
  let resolveFirst;
  let resolveSecond;
  app.vault.getAbstractFileByPath = (filePath) => new TFile(filePath);
  app.vault.readBinary = () => {
    reads += 1;
    return new Promise((resolve) => {
      if (reads === 1) resolveFirst = resolve;
      else resolveSecond = resolve;
    });
  };

  const snapshot = {
    files: [
      { path: "a.bin", existed: true, isBinary: true, content: "AA==", mtime: 1, ctime: 1 },
      { path: "b.bin", existed: true, isBinary: true, content: "AQ==", mtime: 1, ctime: 1 },
    ],
  };
  const pending = tab.orderSnapshotFilesByChange(snapshot);
  await settle();
  assert.equal(reads, 1);

  resolveFirst(new Uint8Array([1]).buffer);
  await settle();
  assert.equal(reads, 2);

  resolveSecond(new Uint8Array([2]).buffer);
  const ordered = await pending;
  assert.deepEqual(ordered.map((entry) => entry.path), ["a.bin", "b.bin"]);
});
