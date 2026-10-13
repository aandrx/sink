import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";

// Execute the real TS classes against small Obsidian/PouchDB substitutes.
// No live vault, IndexedDB, CouchDB, or credentials are accessed by these tests.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const cache = new Map();
const notFound = () => Object.assign(new Error("missing"), { status: 404 });
class TFile {
  constructor(filePath, content = "", size = Buffer.byteLength(content)) {
    this.path = filePath;
    this.content = content;
    this.stat = { mtime: 1, ctime: 1, size };
  }
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = { empty() {} }; }
  open() { this.onOpen?.(); }
  close() { this.onClose?.(); }
}
const element = () => ({ addClass() {}, removeClass() {}, setText() {}, setAttribute() {} });
class Plugin {
  constructor(app) { this.app = app; this.manifest = { version: "test" }; this.events = []; }
  async loadData() { return { lastSeenVersion: "test" }; }
  async saveData() {}
  addSettingTab() {}
  addStatusBarItem() { return element(); }
  addRibbonIcon() { return element(); }
  registerObsidianProtocolHandler() {}
  registerEvent(event) { this.events.push(event); }
  addCommand() {}
}
class FakeReplication extends EventEmitter {
  cancel() { this.cancelled = true; }
  then(resolve, reject) { return Promise.resolve({ status: this.cancelled ? "cancelled" : "complete" }).then(resolve, reject); }
}
class MockDB {
  constructor() {
    this.docs = new Map(); this.queries = []; this.writes = []; this.replications = [];
    const replicate = (_remote, options) => {
      const replication = new FakeReplication();
      replication.options = options;
      this.replications.push(replication);
      return replication;
    };
    this.replicate = { to: replicate, from: replicate };
  }
  async get(id) { if (!this.docs.has(id)) throw notFound(); return this.docs.get(id); }
  async put(doc) {
    const previous = this.docs.get(doc._id);
    if (previous && previous._rev !== doc._rev) throw Object.assign(new Error("conflict"), { status: 409 });
    this.writes.push(doc._id);
    this.docs.set(doc._id, { ...doc, _rev: `${Number(previous?._rev ?? 0) + 1}` });
    return { ok: true, id: doc._id, rev: this.docs.get(doc._id)._rev };
  }
  async allDocs(options) {
    this.queries.push(options);
    let docs = [...this.docs.entries()].map(([id, doc]) => ({ ...doc, _id: id })).sort((a, b) => a._id.localeCompare(b._id));
    if (options.descending) docs.reverse();
    docs = docs.filter((doc) => options.descending
      ? (!options.startkey || doc._id <= options.startkey) && (!options.endkey || doc._id >= options.endkey)
      : (!options.startkey || doc._id >= options.startkey) && (!options.endkey || doc._id <= options.endkey));
    docs = docs.slice(options.skip ?? 0, options.limit === undefined ? undefined : (options.skip ?? 0) + options.limit);
    return { total_rows: this.docs.size, rows: docs.map((doc) => ({ id: doc._id, doc })) };
  }
  async close() { this.closed = true; }
  async destroy() { this.docs.clear(); }
}
const obsidian = {
  TFile, TAbstractFile: class {}, Modal, Plugin, App: class {},
  Notice: class {}, PluginSettingTab: class {}, Setting: class {}, setTooltip() {},
};
function loadTS(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const { code } = transformSync(readFileSync(filename, "utf8"), { loader: "ts", format: "cjs", target: "es2020" });
  const require = (specifier) => {
    if (specifier === "obsidian") return obsidian;
    if (specifier === "./pouchdb") return { PouchDB: MockDB };
    if (specifier.startsWith(".")) return loadTS(path.relative(root, path.resolve(path.dirname(filename), `${specifier}.ts`)));
    return nodeRequire(specifier);
  };
  new Function("require", "module", "exports", code)(require, module, module.exports);
  return module.exports;
}
const { SyncEngine } = loadTS("src/sync/SyncEngine.ts");
const { FileSerializer } = loadTS("src/sync/FileSerializer.ts");
const { LocalDB } = loadTS("src/sync/LocalDB.ts");
const { Replicator } = loadTS("src/sync/Replicator.ts");
const { DEFAULT_SETTINGS } = loadTS("src/settings.ts");
const { isSyncPathAllowed, arrayBufferToBase64, MAX_FILE_BYTES } = loadTS("src/sync/safety.ts");
const { BatchReviewModal } = loadTS("src/ui/BatchReviewModal.ts");
const { CryptoHelper } = loadTS("src/utils/crypto.ts");
const { ConflictResolver } = loadTS("src/sync/ConflictResolver.ts");
const { renderSplitDiff, buildSplitDiff, buildDiffDisplayRows } = loadTS("src/ui/DiffView.ts");
const { default: SinkPlugin } = loadTS("src/SinkPlugin.ts");
const doc = (filePath, content = "remote") => ({ _id: `file:${filePath}`, path: filePath, content, size: content.length, mtime: 2, ctime: 1, type: "file", deviceId: "remote" });
function fixture(settings = {}) {
  const files = new Map();
  const vault = {
    configDir: ".obsidian", writes: [], binaryReads: 0, listeners: [],
    getName: () => "test", getFiles: () => [...files.values()],
    getAbstractFileByPath: (filePath) => files.get(filePath),
    async read(file) { return file.content; },
    async readBinary() { this.binaryReads++; return new Uint8Array([1, 2, 3]).buffer; },
    async createFolder() {},
    async create(filePath, content) { this.writes.push(filePath); files.set(filePath, new TFile(filePath, content)); },
    async modify(file, content, options) { this.writes.push(file.path); file.content = content; file.stat.mtime = options?.mtime ?? 3; },
    async createBinary(filePath) { this.writes.push(filePath); },
    async modifyBinary(file) { this.writes.push(file.path); },
    async delete(file) { this.writes.push(file.path); files.delete(file.path); },
    on(name, callback) { const ref = { name, callback }; this.listeners.push(ref); return ref; },
  };
  const app = { vault, workspace: { onLayoutReady() {} } };
  const errors = [];
  const engine = new SyncEngine(app, vault, { ...DEFAULT_SETTINGS, deviceId: "local", deviceName: "local", ...settings }, "test", "test", (event) => { if (event.type === "error") errors.push(event.message); });
  return { engine, vault, files, app, errors, db: engine.localDB.instance };
}
const gate = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test("config exclusions apply in both directions, including custom config directories", () => {
  assert.equal(DEFAULT_SETTINGS.syncConfigFolder, false);
  assert.equal(isSyncPathAllowed("notes/a.md", ".obsidian", false), true);
  assert.equal(isSyncPathAllowed(".custom/appearance.json", ".custom", false), false);
  assert.equal(isSyncPathAllowed(".custom/appearance.json", ".custom", true), true);
  for (const name of ["workspace.json", "workspace-mobile.json", "community-plugins.json", "core-plugins.json", "plugins/sink/main.js", "plugins/sink/data.json"]) {
    assert.equal(isSyncPathAllowed(`.custom/${name}`, ".custom", true), false, name);
  }
  for (const filePath of ["../x", "a/../x", "/x", "C:/x", "a\\x", "a//x"]) assert.equal(isSyncPathAllowed(filePath, ".obsidian", true), false);
});

test("block base64 encoding round-trips across block and padding boundaries", () => {
  for (const size of [0, 1, 2, 3, 24575, 24576, 24577, 100000]) {
    const data = Uint8Array.from({ length: size }, (_, i) => i % 256);
    assert.equal(arrayBufferToBase64(data.buffer), Buffer.from(data).toString("base64"));
  }
});

test("oversized upload is rejected before the vault read", async () => {
  const { engine, vault } = fixture();
  const serializer = new FileSerializer(vault, engine.localDB);
  await assert.rejects(serializer.fileToDoc(new TFile("huge.pdf", "", MAX_FILE_BYTES + 1)), /safety limit/);
  assert.equal(vault.binaryReads, 0);
});

test("encrypted chunks fail closed, while plaintext legacy chunks remain supported", async () => {
  const { engine, vault, db } = fixture();
  db.docs.set("chunk:a", { _id: "chunk:a", type: "chunk", data: "ciphertext", iv: "iv" });
  const serializer = new FileSerializer(vault, engine.localDB);
  const chunked = { ...doc("note.md", ""), chunks: ["chunk:a"] };
  await assert.rejects(serializer.docToFile(chunked, async () => { throw new Error("bad key"); }), /bad key/);
  assert.equal(vault.writes.length, 0);
  db.docs.set("chunk:a", { type: "chunk", data: "legacy" });
  assert.equal(await serializer.readDocContent(chunked, async () => { throw new Error("must not decrypt plaintext"); }), "legacy");
});

test("chunked text is reconstructed for review/merge; identical notes are skipped", async () => {
  const { engine, db, files } = fixture();
  db.docs.set("chunk:a", { type: "chunk", data: "actual text" });
  const incoming = { ...doc("note.md", ""), chunks: ["chunk:a"] };
  const prepared = await engine.prepareIncomingChanges([incoming]);
  assert.equal(prepared[0].remoteContent, "actual text");
  assert.equal(prepared[0].remoteDoc.chunks, undefined);
  files.set("note.md", new TFile("note.md", "actual text"));
  assert.equal((await engine.prepareIncomingChanges([incoming])).length, 0);
});

test("binary review inspects metadata without reading the local binary", async () => {
  const { engine, vault, files } = fixture();
  files.set("image.png", new TFile("image.png", ""));
  await engine.prepareIncomingChanges([doc("image.png", "AQID")]);
  assert.equal(vault.binaryReads, 0);
});

test("incoming config is filtered, and toggling off blocks an already prepared write", async () => {
  const { engine, vault } = fixture({ syncConfigFolder: true });
  const prepared = await engine.prepareIncomingChanges([doc(".obsidian/appearance.json", "{}")]);
  assert.equal(prepared.length, 1);
  engine.settings.syncConfigFolder = false;
  await engine.applyRemoteChange(prepared[0]);
  assert.equal(vault.writes.length, 0);
  assert.equal((await engine.prepareIncomingChanges([doc(".obsidian/appearance.json")])).length, 0);
});

test("device/snapshot queries constrain the ID range and snapshot count", async () => {
  const local = new LocalDB("test");
  await local.getAllDeviceDocs();
  await local.getSnapshotSummaries(3);
  assert.equal(local.instance.queries[0].startkey, "meta:device:");
  assert.equal(local.instance.queries[1].endkey, "meta:snapshot:");
  assert.equal(local.instance.queries[1].limit, 3);
  assert.equal(local.instance.queries[1].include_docs, false);
});

test("incoming batches serialize, retain only IDs, and continue after a rejected batch", async () => {
  const { engine, db, errors } = fixture();
  const first = gate(); const entered = gate();
  let active = 0; let maximum = 0; let calls = 0;
  for (const name of ["a.md", "b.md"]) db.docs.set(`file:${name}`, doc(name));
  engine.handleIncomingChanges = async () => {
    maximum = Math.max(maximum, ++active);
    calls++;
    try { if (calls === 1) { entered.resolve(); await first.promise; throw new Error("batch failure"); } }
    finally { active--; }
  };
  engine.scheduleIncoming([doc("a.md")]);
  await entered.promise;
  engine.scheduleIncoming([doc("b.md")]);
  assert.deepEqual([...engine.pendingIncoming], ["file:b.md"]);
  first.resolve();
  await engine.operationQueue;
  assert.equal(maximum, 1); assert.equal(calls, 2);
  assert.ok(errors.some((message) => message.includes("batch failure")));
});

test("parents with missing chunks are retried when chunks arrive", async () => {
  const { engine, db, vault } = fixture();
  engine.sessionMergeAllowed = true;
  const incoming = { ...doc("note.md", ""), chunks: ["chunk:a"] };
  db.docs.set(incoming._id, incoming);
  engine.scheduleIncoming([incoming]);
  await engine.operationQueue;
  assert.equal(engine.deferredIncoming.has(incoming._id), true);
  db.docs.set("chunk:a", { type: "chunk", data: "recovered" });
  engine.scheduleIncoming([{ _id: "chunk:a", type: "chunk" }]);
  await engine.operationQueue;
  assert.deepEqual(vault.writes, ["note.md"]);
});

test("full pull pages only file docs, excluding snapshot and chunk bodies", async () => {
  const { engine, db } = fixture();
  for (let i = 0; i < 13; i++) db.docs.set(`file:${i}.md`, doc(`${i}.md`));
  db.docs.set("chunk:huge", { type: "chunk", data: "ignored" });
  db.docs.set("meta:snapshot:huge", { type: "meta", metaType: "snapshot", files: [] });
  engine.applyIncomingChangesWithReview = async (changes) => changes.length;
  assert.equal(await engine.pullServerToVault(), 13);
  assert.ok(db.queries.every((query) => query.startkey.startsWith("file:") && query.endkey === "file:\uffff" && query.limit === 5));
});

test("write suppression spans slow async writes and briefly persists after completion", async () => {
  const { engine } = fixture();
  const first = gate(); const entered = gate();
  engine.serializer.docToFile = async () => { entered.resolve(); await first.promise; };
  const [prepared] = await engine.prepareIncomingChanges([doc("note.md")]);
  const writing = engine.applyRemoteChange(prepared);
  await entered.promise;
  assert.equal(engine.processing.get("note.md"), Infinity);
  assert.equal(engine.isProcessing("note.md"), true);
  first.resolve(); await writing;
  assert.equal(engine.isProcessing("note.md"), true);
});

test("shutdown cancels an open review and closes the database without applying", async () => {
  const { engine, vault, db } = fixture();
  const previous = BatchReviewModal.prototype.onOpen;
  BatchReviewModal.prototype.onOpen = () => {};
  try {
    const [prepared] = await engine.prepareIncomingChanges([doc("note.md")]);
    const reviewing = engine.reviewBatch("test", [prepared]);
    await engine.shutdown();
    assert.equal((await reviewing).approved, false);
    await engine.applyRemoteChange(prepared);
    assert.equal(vault.writes.length, 0);
    assert.equal(db.closed, true);
  } finally { BatchReviewModal.prototype.onOpen = previous; }
});

test("serializer rechecks cancellation after awaiting chunk retrieval", async () => {
  const { engine, vault, db } = fixture();
  const entered = gate(); const first = gate();
  db.get = async () => { entered.resolve(); await first.promise; return { data: "text" }; };
  let allowed = true;
  const writing = engine.serializer.docToFile({ ...doc("note.md", ""), chunks: ["chunk:a"] }, undefined, () => allowed);
  await entered.promise;
  allowed = false; first.resolve(); await writing;
  assert.equal(vault.writes.length, 0);
});

test("chunks are persisted before parents and repeated encrypted chunks are reused", async () => {
  const { engine, db, files } = fixture();
  engine.crypto = { async encrypt(content) { return { ciphertext: content, iv: "iv" }; } };
  const file = new TFile("large.md", "x".repeat(70000));
  files.set(file.path, file);
  await engine.pushFile(file);
  assert.ok(db.writes.findIndex((id) => id.startsWith("chunk:")) < db.writes.indexOf("file:large.md"));
  const chunksWritten = db.writes.filter((id) => id.startsWith("chunk:")).length;
  await engine.pushFile(file);
  assert.equal(db.writes.filter((id) => id.startsWith("chunk:")).length, chunksWritten);
});

test("replication ignores push confirmations and callbacks from cancelled generations", () => {
  const db = new MockDB(); const events = [];
  const replicator = new Replicator({ instance: db }, { instance: {} }, (event) => events.push(event));
  replicator.start();
  const [push, pull] = db.replications;
  push.emit("change", { docs: [doc("a.md")] });
  assert.equal(events.some((event) => event.type === "change"), false);
  pull.emit("change", { docs: [doc("a.md")] });
  assert.equal(events.filter((event) => event.type === "change").length, 1);
  replicator.stop(); replicator.start();
  const length = events.length;
  pull.emit("change", { docs: [doc("b.md")] }); push.emit("error", { status: 401 });
  assert.equal(events.length, length);
  assert.equal(replicator.isActive, true);
  assert.equal(push.options.batches_limit, 1);
  replicator.stop();
});

test("plugin restarts do not add vault listeners or retain old local databases", async () => {
  const { app, vault } = fixture();
  const plugin = new SinkPlugin(app);
  await plugin.onload();
  assert.equal(vault.listeners.length, 4);
  await plugin.startSync();
  const previous = plugin.getSyncEngine().localDB.instance;
  await Promise.all([plugin.startSync(), plugin.startSync()]);
  assert.equal(vault.listeners.length, 4);
  assert.equal(previous.closed, true);
  await plugin.onunload();
  assert.equal(plugin.getSyncEngine(), null);
});

test("real encrypted parent/chunks survive preparation and application for text and binary", async () => {
  const { engine, db, files, vault } = fixture();
  const helper = new CryptoHelper("test-only-passphrase");
  engine.crypto = helper;
  for (const [filePath, text] of [["encrypted.md", "plaintext note"], ["encrypted.png", "AQID"]]) {
    const chunk = await helper.encrypt(text);
    const parent = await helper.encrypt("");
    db.docs.set(`chunk:${filePath}`, { data: chunk.ciphertext, iv: chunk.iv, type: "chunk" });
    const [prepared] = await engine.prepareIncomingChanges([{ ...doc(filePath, parent.ciphertext), iv: parent.iv, chunks: [`chunk:${filePath}`] }]);
    assert.equal(prepared.remoteEncrypted, true);
    assert.equal(prepared.remoteDoc.iv, undefined);
    await engine.applyRemoteChange(prepared);
    if (filePath.endsWith(".md")) assert.equal(files.get(filePath).content, text);
  }
  assert.deepEqual(vault.writes, ["encrypted.md", "encrypted.png"]);
});

test("snapshot budget refuses a large backup before reading binary data", async () => {
  const { engine, files, vault } = fixture();
  files.set("large.pdf", new TFile("large.pdf", "", 12 * 1024 * 1024));
  await assert.rejects(engine.createSnapshot("test", ["large.pdf"], "remote"), /budget/);
  assert.equal(vault.binaryReads, 0);
  assert.equal(vault.writes.length, 0);
});

test("local edits during review prevent a stale overwrite", async () => {
  const { engine, files, vault } = fixture();
  const file = new TFile("note.md", "original");
  files.set(file.path, file);
  const prepared = await engine.prepareIncomingChanges([doc("note.md")]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => {
    file.content = "new local edit"; file.stat.mtime = 10;
    return engine.acceptAll(prepared);
  };
  assert.equal(await engine.applyIncomingChangesWithReview(prepared, "test"), 0);
  assert.equal(file.content, "new local edit");
  assert.equal(vault.writes.length, 0);
});

test("large diffs and excessive preview rows are refused without constructing DOM rows", () => {
  const resolver = new ConflictResolver();
  assert.equal(resolver.resolve(doc("a.md", "a".repeat(600000)), doc("a.md", "b".repeat(600000)), true).resolved, false);
  const messages = [];
  renderSplitDiff({ createEl(_tag, options) { messages.push(options.text); }, createDiv() { throw new Error("must not build diff DOM"); } }, "left", "right", "\n".repeat(4001), "");
  assert.equal(messages.length, 1);
});

test("line diff realigns after multi-line insertions and deletions", () => {
  const added = buildSplitDiff("start\nend", "start\none\ntwo\nthree\nend");
  assert.deepEqual(added.map((row) => row.kind), ["equal", "insert", "insert", "insert", "equal"]);
  assert.equal(added[4].leftNumber, "2");
  assert.equal(added[4].rightNumber, "5");
  assert.equal(added[1].leftNumber, undefined);
  const removed = buildSplitDiff("start\none\ntwo\nthree\nend", "start\nend");
  assert.deepEqual(removed.map((row) => row.kind), ["equal", "delete", "delete", "delete", "equal"]);
});

test("replacement blocks align both sides and preserve character highlights", () => {
  const rows = buildSplitDiff("name: old\nremove\nanchor", "name: new\nanchor");
  assert.deepEqual(rows.map((row) => row.kind), ["change", "delete", "equal"]);
  assert.equal(rows[0].leftSegments.map((segment) => segment.text).join(""), "name: old");
  assert.equal(rows[0].rightSegments.map((segment) => segment.text).join(""), "name: new");
  assert.ok(rows[0].leftSegments.some((segment) => segment.changed));
  assert.ok(rows[0].rightSegments.some((segment) => segment.changed));
  assert.equal(rows[2].leftNumber, "3");
  assert.equal(rows[2].rightNumber, "2");
});

test("empty files, blank lines, repeated lines, and CRLF preserve source line sequences", () => {
  for (const [left, right] of [["", "new"], ["gone", ""], ["", ""], ["a\n\nb\n", "a\nnew\n\nb\n"], ["a\na\nb", "a\nb\na\nb"], ["a\r\nb", "a\nb"]]) {
    const rows = buildSplitDiff(left, right);
    const lines = (text) => text === "" ? [] : text.split(/\r?\n/);
    assert.deepEqual(rows.filter((row) => row.leftNumber !== undefined).map((row) => row.leftText), lines(left));
    assert.deepEqual(rows.filter((row) => row.rightNumber !== undefined).map((row) => row.rightText), lines(right));
    rows.filter((row) => row.leftNumber !== undefined).forEach((row, index) => assert.equal(row.leftNumber, String(index + 1)));
    rows.filter((row) => row.rightNumber !== undefined).forEach((row, index) => assert.equal(row.rightNumber, String(index + 1)));
  }
});

test("unchanged context folds without hiding any changed rows and expands losslessly", () => {
  const left = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const right = [...left]; right[20] = "replacement";
  const rows = buildSplitDiff(left.join("\n"), right.join("\n"));
  const display = buildDiffDisplayRows(rows);
  assert.equal(display.filter((entry) => entry.kind === "line" && entry.row.kind !== "equal").length, 1);
  const folds = display.filter((entry) => entry.kind === "fold");
  assert.equal(folds.length, 2);
  assert.equal(buildDiffDisplayRows(rows, new Set(folds.map((fold) => fold.start))).length, rows.length);
  assert.equal(buildDiffDisplayRows(rows, new Set(), true).length, rows.length);
  assert.equal(display.reduce((count, entry) => count + (entry.kind === "fold" ? entry.count : 1), 0), rows.length);
});

function diffDOM(leftText, rightText) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id='test'></div></body></html>", { pretendToBeVisual: true });
  const { document, HTMLElement } = dom.window;
  const proto = HTMLElement.prototype;
  proto.createEl = function(tag, options = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
    this.append(el);
    return el;
  };
  proto.createDiv = function(options) { return this.createEl("div", options); };
  proto.createSpan = function(options) { return this.createEl("span", options); };
  proto.setText = function(text) { this.textContent = text; };
  proto.empty = function() { this.replaceChildren(); };
  proto.addClass = function(...names) { this.classList.add(...names); };
  proto.removeClass = function(...names) { this.classList.remove(...names); };
  const style = document.createElement("style");
  style.textContent = readFileSync(path.join(root, "styles.css"), "utf8");
  document.head.append(style);
  const container = document.getElementById("test");
  renderSplitDiff(container, "Local", "Remote", leftText, rightText);
  return { dom, container, window: dom.window };
}

test("viewer gets its two-column styling without a conflict-modal ancestor", () => {
  const { dom, container, window } = diffDOM("before", "after");
  try {
    assert.equal(container.querySelectorAll(".sink-diff-pane").length, 2);
    const split = container.querySelector(".sink-diff-split");
    assert.equal(window.getComputedStyle(split).display, "grid");
    assert.equal(window.getComputedStyle(split).gridTemplateColumns, "minmax(0, 1fr) minmax(0, 1fr)");
    assert.equal(window.getComputedStyle(container.querySelector(".sink-diff-line-text")).whiteSpace, "pre");
    assert.ok(container.querySelector(".sink-diff-left .sink-diff-delete"));
    assert.ok(container.querySelector(".sink-diff-right .sink-diff-insert"));
    assert.equal(container.querySelector(".sink-diff-summary").textContent, "−1 removed+1 added");
  } finally { dom.window.close(); }
});

test("diff scroll synchronizes in both directions without echoing programmatic scrolls", () => {
  const { dom, container, window } = diffDOM("a", "b");
  try {
    const [left, right] = container.querySelectorAll(".sink-diff-scroll");
    left.scrollTop = 120; left.scrollLeft = 75;
    left.dispatchEvent(new window.Event("scroll"));
    assert.equal(right.scrollTop, 120); assert.equal(right.scrollLeft, 75);
    right.dispatchEvent(new window.Event("scroll"));
    assert.equal(left.scrollTop, 120);
    right.scrollTop = 40; right.scrollLeft = 15;
    right.dispatchEvent(new window.Event("scroll"));
    assert.equal(left.scrollTop, 40); assert.equal(left.scrollLeft, 15);
  } finally { dom.window.close(); }
});

test("context expansion and next/previous navigation update both panes", () => {
  const original = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const changed = [...original]; changed[10] = "first edit"; changed[30] = "second edit";
  const { dom, container } = diffDOM(original.join("\n"), changed.join("\n"));
  try {
    const rows = () => [...container.querySelectorAll(".sink-diff-lines")].map((body) => body.children.length);
    assert.ok(rows()[0] < 40);
    container.querySelector(".sink-diff-left .sink-diff-fold").click();
    assert.equal(rows()[0], rows()[1]);
    const toggle = container.querySelector(".sink-diff-context-button");
    toggle.click();
    assert.deepEqual(rows(), [40, 40]);
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    const next = container.querySelector('[aria-label="Next change"]');
    next.click();
    assert.equal(container.querySelectorAll(".sink-diff-current-change").length, 2);
    assert.equal(container.querySelector(".sink-diff-position").textContent, "1 / 2 changes");
    next.click();
    assert.equal(container.querySelector(".sink-diff-position").textContent, "2 / 2 changes");
    container.querySelector('[aria-label="Previous change"]').click();
    assert.equal(container.querySelector(".sink-diff-position").textContent, "1 / 2 changes");
  } finally { dom.window.close(); }
});

test("identical diff disables navigation and note HTML is displayed as text", () => {
  const text = '<img src=x onerror="alert(1)">';
  const { dom, container } = diffDOM(text, text);
  try {
    assert.equal(container.querySelector(".sink-diff-summary").textContent, "No differences");
    assert.equal(container.querySelector('[aria-label="Next change"]').disabled, true);
    assert.equal(container.querySelector("img"), null);
    assert.equal(container.querySelector(".sink-diff-line-text").textContent, text);
  } finally { dom.window.close(); }
});