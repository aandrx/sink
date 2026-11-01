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
    this.leaves = new Map();
    const replicate = (_remote, options) => {
      const replication = new FakeReplication();
      replication.options = options;
      this.replications.push(replication);
      return replication;
    };
    this.replicate = { to: replicate, from: replicate };
  }
  seedConflict(id, leaves, winnerRev) {
    const map = new Map();
    for (const leaf of leaves) {
      if (!leaf._rev) throw new Error("seeded leaves need revisions");
      map.set(leaf._rev, { ...leaf, _id: id });
    }
    if (!map.has(winnerRev)) throw new Error("seeded winner must be a leaf");
    this.leaves.set(id, { leaves: map, winnerRev });
    this.syncConflictDoc(id);
  }
  conflictLeaves(id) {
    const entry = this.leaves.get(id);
    return entry ? [...entry.leaves.values()].map((leaf) => ({ ...leaf })) : [];
  }
  syncConflictDoc(id) {
    const entry = this.leaves.get(id);
    if (!entry) return;
    const winner = entry.leaves.get(entry.winnerRev);
    if (!winner) { this.docs.delete(id); return; }
    const conflicts = [...entry.leaves.keys()].filter((rev) => rev !== entry.winnerRev).sort();
    this.docs.set(id, { ...winner, ...(conflicts.length ? { _conflicts: conflicts } : {}) });
  }
  nextConflictRevision(entry, rev) {
    let number = (Number.parseInt(String(rev ?? "0").split("-")[0], 10) || 0) + 1;
    let candidate = `${number}-test`;
    while (entry.leaves.has(candidate)) candidate = `${++number}-test`;
    return candidate;
  }
  chooseConflictWinner(entry) {
    const leaves = [...entry.leaves.values()];
    const live = leaves.filter((leaf) => !leaf.deleted);
    const pool = live.length ? live : leaves;
    pool.sort((left, right) => String(right._rev).localeCompare(String(left._rev)));
    return pool[0]._rev;
  }
  async get(id, options = {}) {
    const entry = this.leaves.get(id);
    if (entry) {
      if (options?.open_revs) {
        return [...entry.leaves.values()].map((leaf) => ({ ok: { ...leaf } }));
      }
      if (options?.rev) {
        const leaf = entry.leaves.get(options.rev);
        if (!leaf) throw notFound();
        return { ...leaf };
      }
      const winner = entry.leaves.get(entry.winnerRev);
      if (!winner) throw notFound();
      const conflicts = [...entry.leaves.keys()].filter((rev) => rev !== entry.winnerRev).sort();
      return { ...winner, ...(options?.conflicts && conflicts.length ? { _conflicts: conflicts } : {}) };
    }
    if (!this.docs.has(id)) throw notFound();
    const stored = this.docs.get(id);
    if (options?.open_revs) {
      const result = [{ ok: { ...stored } }];
      for (const rev of Array.isArray(stored._conflicts) ? stored._conflicts : []) {
        result.push({ ok: { ...stored, _rev: rev } });
      }
      return result;
    }
    if (options?.rev) {
      if (stored._rev !== options.rev && !(stored._conflicts ?? []).includes(options.rev)) throw notFound();
      return { ...stored, _rev: options.rev };
    }
    return stored;
  }
  async put(doc) {
    const entry = this.leaves.get(doc._id);
    if (entry) {
      if (doc._rev && !entry.leaves.has(doc._rev)) throw Object.assign(new Error("conflict"), { status: 409 });
      const rev = this.nextConflictRevision(entry, doc._rev);
      const next = { ...doc, _rev: rev };
      if (doc._rev) entry.leaves.delete(doc._rev);
      entry.leaves.set(rev, next);
      entry.winnerRev = rev;
      this.writes.push(doc._id);
      this.syncConflictDoc(doc._id);
      return { ok: true, id: doc._id, rev };
    }
    const previous = this.docs.get(doc._id);
    if (previous && previous._rev !== doc._rev) throw Object.assign(new Error("conflict"), { status: 409 });
    this.writes.push(doc._id);
    this.docs.set(doc._id, { ...doc, _rev: `${Number(previous?._rev ?? 0) + 1}` });
    return { ok: true, id: doc._id, rev: this.docs.get(doc._id)._rev };
  }
  async remove(documentOrId, revision) {
    const id = typeof documentOrId === "string" ? documentOrId : documentOrId._id;
    const rev = typeof documentOrId === "string" ? revision : documentOrId._rev;
    const entry = this.leaves.get(id);
    if (entry) {
      if (!entry.leaves.has(rev)) throw notFound();
      entry.leaves.delete(rev);
      this.writes.push(id);
      if (entry.leaves.size === 0) {
        this.leaves.delete(id);
        this.docs.delete(id);
      } else {
        if (entry.winnerRev === rev) entry.winnerRev = this.chooseConflictWinner(entry);
        this.syncConflictDoc(id);
      }
      return { ok: true, id, rev };
    }
    const stored = this.docs.get(id);
    if (!stored) throw notFound();
    if (stored._rev !== rev) throw Object.assign(new Error("conflict"), { status: 409 });
    this.docs.delete(id);
    this.writes.push(id);
    return { ok: true, id, rev };
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
  async destroy() { this.docs.clear(); this.leaves.clear(); }
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
const leafDoc = (filePath, content, rev, extra = {}) => ({ ...doc(filePath, content), _rev: rev, ...extra });
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

test("denied uploads are not counted as successful pushes", async () => {
  const { engine, files } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  engine.ensurePushAllowed = async () => false;
  assert.equal(await engine.pushFile(file), false);
  assert.equal(await engine.pushVaultToServer(), 0);
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
  engine.handleIncomingIds = async () => {
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
  assert.ok(db.queries.every((query) => query.startkey.startsWith("file:") && query.endkey === "file:\uffff" && query.include_docs === false));
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

test("shutdown waits for a pending startup before closing IndexedDB", async () => {
  const { engine, db } = fixture();
  const entered = gate();
  const release = gate();
  const original = Replicator.prototype.pullOnce;
  Replicator.prototype.pullOnce = async () => {
    entered.resolve();
    await release.promise;
  };
  try {
    const starting = engine.start();
    await entered.promise;
    const stopping = engine.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(db.closed, undefined);
    release.resolve();
    await starting;
    await stopping;
    assert.equal(db.closed, true);
  } finally {
    Replicator.prototype.pullOnce = original;
  }
});

test("one LocalDB connection closing does not close a replacement connection", async () => {
  const first = new LocalDB("shared-reopen");
  const second = new LocalDB("shared-reopen");
  await first.close();
  assert.equal(first.instance.closed, undefined);
  await second.put({ _id: "file:kept.md", path: "kept.md", content: "kept", mtime: 1, ctime: 1, size: 4, type: "file" });
  assert.equal(second.instance.closed, undefined);
  await second.close();
  assert.equal(second.instance.closed, true);
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

test("one complete review preflights bounded snapshots before applying a larger file set", async () => {
  const { engine, files } = fixture();
  const paths = ["a.pdf", "b.pdf", "c.pdf", "d.pdf"];
  for (const name of paths) files.set(name, new TFile(name, "", 3 * 1024 * 1024));
  const prepared = await engine.prepareIncomingChanges(paths.map((name) => doc(name)));
  let reviews = 0;
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => { reviews++; return engine.acceptAll(prepared); };
  const events = [];
  engine.createSnapshot = async (_reason, group) => {
    const estimate = group.reduce((sum, name) => sum + files.get(name).stat.size * 3, 0);
    assert.ok(estimate <= 32 * 1024 * 1024, "each backup must respect the memory budget");
    events.push(`backup:${group.length}`);
  };
  engine.applyRemoteChange = async () => { events.push("apply"); return true; };
  assert.equal(await engine.applyIncomingChangesWithReview(prepared, "large pull"), 4);
  assert.equal(reviews, 1);
  assert.deepEqual(events, ["backup:3", "backup:1", "apply", "apply", "apply", "apply"]);
});

test("a later backup failure prevents all selected vault changes", async () => {
  const { engine, files, vault } = fixture();
  const paths = ["a.pdf", "b.pdf", "c.pdf", "d.pdf"];
  for (const name of paths) files.set(name, new TFile(name, "", 3 * 1024 * 1024));
  const prepared = await engine.prepareIncomingChanges(paths.map((name) => doc(name)));
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => engine.acceptAll(prepared);
  let backups = 0;
  let applied = 0;
  engine.createSnapshot = async () => { if (++backups === 2) throw new Error("backup quota unavailable"); };
  engine.applyRemoteChange = async () => { applied++; return true; };
  await assert.rejects(engine.applyIncomingChangesWithReview(prepared, "large pull"), /backup quota/);
  assert.equal(applied, 0);
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
test("conflict resolver refuses to guess a merge without an ancestor", () => {
  const resolver = new ConflictResolver();
  const result = resolver.resolve(doc("note.md", "local text"), doc("note.md", "remote text"), true);
  assert.equal(result.resolved, false);
  assert.equal(result.content, "local text");
  assert.equal(result.mine, "local text");
  assert.equal(result.theirs, "remote text");
  assert.equal(resolver.resolve(doc("note.md", "same"), doc("note.md", "same"), true).resolved, true);
});

test("divergent text is suggested as an explicit side choice, not a merge", async () => {
  const { engine, files } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  const [prepared] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  assert.notEqual(prepared.suggested, "merge");
  assert.ok(prepared.suggested === "keep-local" || prepared.suggested === "keep-remote");
});

test("session allowance never bypasses deletion, retained branches, or divergent edits", async () => {
  const { engine, files } = fixture();
  engine.sessionMergeAllowed = true;
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);

  const [divergent] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  assert.equal(await engine.shouldReviewBatch([divergent]), true);

  const [deletion] = await engine.prepareIncomingChanges([{ ...doc("note.md", ""), deleted: true, mtime: 3 }]);
  assert.equal(await engine.shouldReviewBatch([deletion]), true);

  const [conflicted] = await engine.prepareIncomingChanges([{ ...doc("note.md", "remote text"), _conflicts: ["2-other"] }]);
  assert.equal(conflicted.hasUnresolvedConflicts, true);
  assert.equal(await engine.shouldReviewBatch([conflicted]), true);
});

test("merge choice on divergent text fails closed without replacing local content", async () => {
  const { engine, files, vault, errors } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  const [prepared] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "merge" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 0);
  assert.equal(file.content, "local text");
  assert.equal(vault.writes.length, 0);
  assert.ok(errors.some((message) => message.includes("no common ancestor")));
});

test("denied preauthorization happens before snapshots and changes nothing", async () => {
  const { engine, files, vault } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  const [prepared] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-local" }],
  });
  let snapshots = 0;
  engine.createSnapshot = async () => { snapshots += 1; return "snapshot"; };
  engine.ensurePushAllowed = async () => false;

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 0);
  assert.equal(snapshots, 0);
  assert.equal(file.content, "local text");
  assert.equal(vault.writes.length, 0);
});

test("same-mtime local content changes still prevent a stale overwrite", async () => {
  const { engine, files, vault } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  const [prepared] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => {
    file.content = "edited during review";
    return engine.acceptAll([prepared]);
  };

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 0);
  assert.equal(file.content, "edited during review");
  assert.equal(vault.writes.length, 0);
});

test("cancelled pull stops after one complete review and stays behind", async () => {
  const { engine, db } = fixture();
  for (let i = 0; i < 13; i++) db.docs.set(`file:${i}.md`, doc(`${i}.md`));
  let reviews = 0;
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => {
    reviews += 1;
    return { approved: false, decisions: [] };
  };

  assert.equal(await engine.pullServerToVault(), 0);
  assert.equal(reviews, 1);
  assert.equal(engine.getSyncHeadState(), "behind");
  assert.equal(engine.getStatus(), "paused");
});

test("review is paused and a denial is not immediately re-prompted by queued arrivals", async () => {
  const { engine, db } = fixture();
  db.docs.set("file:a.md", doc("a.md"));
  db.docs.set("file:b.md", doc("b.md"));
  const entered = gate();
  const release = gate();
  let reviews = 0;
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => {
    reviews += 1;
    assert.equal(engine.getStatus(), "paused");
    entered.resolve();
    await release.promise;
    return { approved: false, decisions: [] };
  };

  engine.scheduleIncoming([doc("a.md")]);
  await entered.promise;
  engine.scheduleIncoming([doc("b.md")]);
  release.resolve();
  await engine.operationQueue;

  assert.equal(reviews, 1);
  assert.equal(engine.pendingIncoming.size, 1);
  assert.deepEqual([...engine.pendingIncoming], ["file:b.md"]);
  assert.equal(engine.heldIncoming.has("file:a.md"), true);
  assert.equal(engine.getSyncHeadState(), "behind");
  assert.equal(engine.getStatus(), "paused");
});

test("selected diff previews are loaded lazily from current local and prepared remote content", async () => {
  const { engine, files } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  const [prepared] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  assert.equal(typeof prepared.loadPreview, "function");
  file.content = "newer local text";
  assert.deepEqual(await prepared.loadPreview(), { localContent: "newer local text", remoteContent: "remote text" });
});

test("snapshot crypto is configured after engine crypto changes", () => {
  const { engine } = fixture();
  let seen = "unset";
  engine.localDB.configureSnapshotCrypto = (crypto) => { seen = crypto; };
  engine.updateSettings({ ...engine.settings, passphrase: "test-only-passphrase" });
  assert.ok(seen instanceof CryptoHelper);
  engine.updateSettings({ ...engine.settings, passphrase: "" });
  assert.equal(seen, null);
});

test("last-applied fingerprint distinguishes a remote fast-forward from a local diverging edit", async () => {
  const { engine, files } = fixture();
  const file = new TFile("note.md", "applied text");
  files.set(file.path, file);
  await engine.saveLastAppliedFingerprint("note.md", "applied text");

  const [fastForward] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  assert.equal(fastForward.safeFastForward, true);
  assert.equal(fastForward.suggested, "keep-remote");

  file.content = "offline local edit";
  const [diverged] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  assert.equal(diverged.safeFastForward, false);
  assert.equal(await engine.shouldReviewBatch([diverged]), true);
});

test("empty deletion and chunk parents are not misclassified as identical versions", () => {
  const resolver = new ConflictResolver();
  assert.equal(resolver.resolve(doc("empty.md", ""), { ...doc("empty.md", ""), deleted: true }, true).resolved, false);
  assert.equal(resolver.resolve({ ...doc("chunked.md", ""), chunks: ["chunk:a"] }, { ...doc("chunked.md", ""), chunks: ["chunk:b"] }, true).resolved, false);
});

test("a supplied ancestor is not treated as a safe merge proof", () => {
  const resolver = new ConflictResolver();
  const result = resolver.resolve(doc("note.md", "local text"), doc("note.md", "remote text"), true, "common ancestor");
  assert.equal(result.resolved, false);
  assert.equal(result.content, "local text");
});

test("light pull candidates retain no plaintext bodies and fetch previews only when selected", async () => {
  const { engine, db } = fixture();
  const docs = [];
  for (let index = 0; index < 1000; index++) {
    const incoming = { ...doc(`note-${index}.md`, `secret-body-${index}`), _rev: `${index + 1}-remote` };
    docs.push(incoming);
    db.docs.set(incoming._id, incoming);
  }
  let reads = 0;
  const originalGet = db.get.bind(db);
  db.get = async (...args) => { reads += 1; return await originalGet(...args); };

  const candidates = await engine.prepareLightCandidates(docs);
  assert.equal(candidates.length, 1000);
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(candidates).includes("secret-body"), false);
  assert.ok(candidates.every((candidate) => candidate.localContent === undefined
    && candidate.remoteContent === undefined
    && candidate.remoteDoc.content === ""
    && candidate.needsHydration === true
    && typeof candidate.loadPreview === "function"));

  await candidates[0].loadPreview();
  assert.equal(reads, 1);
  await candidates[999].loadPreview();
  assert.equal(reads, 2);
});

test("encrypted explicit local publication and remote adoption preserve the chosen contents", async () => {
  const left = fixture({ deviceId: "left", deviceName: "left" });
  const right = fixture({ deviceId: "right", deviceName: "right" });
  left.engine.crypto = new CryptoHelper("test-only-shared-passphrase");
  right.engine.crypto = new CryptoHelper("test-only-shared-passphrase");
  left.files.set("choice.md", new TFile("choice.md", "server version"));
  right.files.set("choice.md", new TFile("choice.md", "chosen local version"));
  const encrypted = await left.engine.crypto.encrypt("server version");
  const initial = { ...doc("choice.md", encrypted.ciphertext), iv: encrypted.iv, deviceId: "left", _rev: "1" };
  right.db.docs.set(initial._id, initial);
  right.engine.shouldReviewBatch = async () => true;
  right.engine.reviewBatch = async (_title, changes) => ({ approved: true, decisions: changes.map((c) => ({ path: c.path, selected: true, decision: "keep-local" })) });
  const candidates = await right.engine.prepareLightCandidates([initial]);
  assert.equal(await right.engine.applyIncomingChangesWithReview(candidates, "choose local"), 1);
  const published = right.db.docs.get(initial._id);
  assert.equal(await left.engine.crypto.decrypt(published.content, published.iv), "chosen local version");
  left.db.docs.set(initial._id, published);
  left.engine.shouldReviewBatch = async () => true;
  left.engine.reviewBatch = async (_title, changes) => ({ approved: true, decisions: changes.map((c) => ({ path: c.path, selected: true, decision: "keep-remote" })) });
  const incoming = await left.engine.prepareLightCandidates([published]);
  assert.equal(await left.engine.applyIncomingChangesWithReview(incoming, "choose server"), 1);
  assert.equal(left.files.get("choice.md").content, "chosen local version");
});

test("a skipped review marker forces a later one-file candidate back into review", async () => {
  const { engine, files } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  const [prepared] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({ approved: true, decisions: [{ path: "note.md", selected: true, decision: "skip" }] });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 0);
  assert.equal(engine.hasDeferredReviewMarker("note.md"), true);

  engine.sessionMergeAllowed = true;
  const [retry] = await engine.prepareIncomingChanges([doc("note.md", "remote text")]);
  assert.equal(retry.hasDeferredReview, true);
  assert.equal(await engine.shouldReviewBatch([retry]), true);
});

test("retained conflict metadata lists every leaf without retaining bodies", async () => {
  const { engine, db } = fixture();
  const id = "file:note.md";
  db.seedConflict(id, [
    leafDoc("note.md", "winner body", "3-winner", { mtime: 30 }),
    leafDoc("note.md", "loser body", "2-loser", { mtime: 20, deviceName: "other", deviceId: "other" }),
    leafDoc("note.md", "old body", "1-old", { mtime: 10 }),
  ], "3-winner");
  const originalLoad = engine.loadAllLeafDocs.bind(engine);
  engine.loadAllLeafDocs = async (leafId) => [
    ...await originalLoad(leafId),
    leafDoc("note.md", "", "0-tombstone", { deleted: true, size: 0 }),
  ];

  const winner = await db.get(id, { conflicts: true });
  const [prepared] = await engine.prepareIncomingChanges([winner]);
  assert.equal(prepared.remoteExists, true);
  assert.equal(prepared.hasUnresolvedConflicts, true);
  assert.equal(prepared.blockedReason, undefined);
  assert.deepEqual(prepared.conflictRevisions.map((revision) => revision.rev), ["3-winner", "1-old", "2-loser"]);
  assert.equal(prepared.conflictRevision, "3-winner");
  const metadata = JSON.stringify(prepared.conflictRevisions);
  assert.equal(metadata.includes("winner body"), false);
  assert.equal(metadata.includes("loser body"), false);
  assert.equal(metadata.includes("old body"), false);
  assert.deepEqual(await prepared.loadConflictPreview("2-loser"), { localContent: "", remoteContent: "loser body" });

  const [light] = await engine.prepareLightCandidates([winner]);
  assert.deepEqual(light.conflictRevisions.map((revision) => revision.rev), ["3-winner", "1-old", "2-loser"]);
  assert.equal(light.remoteDoc.content, "");
  assert.equal(JSON.stringify(light).includes("winner body"), false);
  assert.deepEqual(await light.loadConflictPreview("1-old"), { localContent: "", remoteContent: "old body" });
});

test("a selected non-winning leaf becomes the new winner and retires the other leaves", async () => {
  const { engine, db, files } = fixture();
  const id = "file:note.md";
  files.set("note.md", new TFile("note.md", "local body"));
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
    leafDoc("note.md", "older loser", "1-old"),
  ], "3-winner");
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-remote", conflictRevision: "2-loser" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 1);
  assert.equal(files.get("note.md").content, "chosen loser");
  const final = await db.get(id, { conflicts: true });
  assert.equal(final._conflicts, undefined);
  assert.equal(final.content, "chosen loser");
  assert.deepEqual(db.conflictLeaves(id).map((leaf) => leaf._rev), [final._rev]);
});

test("keep local on a retained conflict republishes local text and leaves no conflicts", async () => {
  const { engine, db, files, vault } = fixture();
  const id = "file:note.md";
  const file = new TFile("note.md", "local body");
  files.set("note.md", file);
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
  ], "3-winner");
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-local", conflictRevision: "2-loser" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 1);
  assert.equal(file.content, "local body");
  const final = await db.get(id, { conflicts: true });
  assert.equal(final._conflicts, undefined);
  assert.equal(final.content, "local body");
  assert.deepEqual(db.conflictLeaves(id).map((leaf) => leaf._rev), [final._rev]);
  assert.deepEqual(vault.writes, []);
});

test("skip on a retained conflict preserves every leaf and writes nothing", async () => {
  const { engine, db, files, vault } = fixture();
  const id = "file:note.md";
  const file = new TFile("note.md", "local body");
  files.set("note.md", file);
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
  ], "3-winner");
  const before = db.conflictLeaves(id).map((leaf) => `${leaf._rev}:${leaf.content}:${!!leaf.deleted}`).sort();
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "skip", conflictRevision: "2-loser" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 0);
  assert.equal(file.content, "local body");
  assert.deepEqual(vault.writes, []);
  const after = db.conflictLeaves(id).map((leaf) => `${leaf._rev}:${leaf.content}:${!!leaf.deleted}`).sort();
  assert.deepEqual(after, before);
  assert.equal((await db.get(id, { conflicts: true })).content, "server winner");
});

test("changed conflict leaves invalidate a selected resolution", async () => {
  const { engine, db, files, errors } = fixture();
  const id = "file:note.md";
  const file = new TFile("note.md", "local body");
  files.set("note.md", file);
  const leaves = [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
  ];
  db.seedConflict(id, leaves, "3-winner");
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  db.seedConflict(id, [...leaves, leafDoc("note.md", "new arrival", "9-arrival")], "3-winner");
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-remote", conflictRevision: "2-loser" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 0);
  assert.equal(file.content, "local body");
  assert.equal(db.conflictLeaves(id).length, 3);
  assert.equal((await db.get(id, { conflicts: true })).content, "server winner");
  assert.ok(errors.some((message) => message.includes("changed during sync review")));
});

test("a leaf arriving before conflict publication is not whitelisted", async () => {
  const { engine, db, files } = fixture();
  const id = "file:note.md";
  files.set("note.md", new TFile("note.md", "local body"));
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
  ], "3-winner");
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  const before = db.conflictLeaves(id).length;
  const original = engine.loadAllLeafDocs.bind(engine);
  engine.loadAllLeafDocs = async (docId) => [...await original(docId), leafDoc("note.md", "arrival", "9-arrival")];
  await assert.rejects(
    engine.resolveConflictChange(prepared, { path: "note.md", selected: true, decision: "keep-remote", conflictRevision: "2-loser" }),
    /unreviewed database revision arrived before conflict resolution/,
  );
  assert.equal(db.conflictLeaves(id).length, before);
  assert.equal((await db.get(id, { conflicts: true })).content, "server winner");
});

test("selecting a deleted conflict leaf deletes the local file and leaves a tombstone winner", async () => {
  const { engine, db, files } = fixture();
  const id = "file:note.md";
  files.set("note.md", new TFile("note.md", "local body"));
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "", "2-gone", { deleted: true, size: 0, mtime: 20 }),
  ], "3-winner");
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-remote", conflictRevision: "2-gone" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 1);
  assert.equal(files.has("note.md"), false);
  const final = await db.get(id, { conflicts: true });
  assert.equal(final._conflicts, undefined);
  assert.equal(final.deleted, true);
  assert.equal(db.conflictLeaves(id).filter((leaf) => !leaf.deleted).length, 0);
});

test("deleted tombstone leaves do not block conflict verification", async () => {
  const { engine, db, files } = fixture();
  const id = "file:note.md";
  files.set("note.md", new TFile("note.md", "local body"));
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
    leafDoc("note.md", "", "0-tombstone", { deleted: true, size: 0, mtime: 0 }),
  ], "3-winner");
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-remote", conflictRevision: "2-loser" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 1);
  assert.equal(files.get("note.md").content, "chosen loser");
  const final = await db.get(id, { conflicts: true });
  assert.equal(final._conflicts, undefined);
  assert.equal(final.content, "chosen loser");
});

test("conflict resolution failure stays behind and keeps the unreviewed leaves", async () => {
  const { engine, db, files, errors } = fixture();
  const id = "file:note.md";
  files.set("note.md", new TFile("note.md", "local body"));
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
  ], "3-winner");
  db.remove = async () => { throw new Error("cannot remove retained leaf"); };
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-remote", conflictRevision: "2-loser" }],
  });

  await engine.handleIncomingChanges([await db.get(id, { conflicts: true })]);
  assert.equal(engine.getSyncHeadState(), "behind");
  assert.equal(engine.getStatus(), "paused");
  assert.ok(errors.some((message) => message.includes("Conflict resolution failed")));
  assert.ok((await db.get(id, { conflicts: true }))._conflicts.length > 0);
});

test("conflict publication is preauthorized before snapshots and writes", async () => {
  const { engine, db, files, vault } = fixture();
  const id = "file:note.md";
  const file = new TFile("note.md", "local body");
  files.set("note.md", file);
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
  ], "3-winner");
  const before = db.conflictLeaves(id).map((leaf) => `${leaf._rev}:${leaf.content}`).sort();
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-remote", conflictRevision: "2-loser" }],
  });
  let snapshots = 0;
  engine.createSnapshot = async () => { snapshots += 1; return "snapshot"; };
  engine.ensurePushAllowed = async () => false;

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 0);
  assert.equal(snapshots, 0);
  assert.equal(file.content, "local body");
  assert.deepEqual(vault.writes, []);
  assert.deepEqual(db.conflictLeaves(id).map((leaf) => `${leaf._rev}:${leaf.content}`).sort(), before);
});

test("keep local with no local file publishes a deletion instead of throwing", async () => {
  const { engine, db, files } = fixture();
  const id = "file:note.md";
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
  ], "3-winner");
  const [prepared] = await engine.prepareLightCandidates([await db.get(id, { conflicts: true })]);
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-local", conflictRevision: "2-loser" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([prepared], "test"), 1);
  assert.equal(files.has("note.md"), false);
  const final = await db.get(id, { conflicts: true });
  assert.equal(final._conflicts, undefined);
  assert.equal(final.deleted, true);
});

test("retirement ignores already-deleted nonconflict tombstones on later passes", async () => {
  const { engine } = fixture();
  const id = "file:note.md";
  let winnerChecks = 0;
  engine.loadPinnedIncomingDoc = async () => ({
    _id: id,
    _rev: "3-winner",
    path: "note.md",
    content: "chosen",
    mtime: 3,
    ctime: 1,
    size: 6,
    type: "file",
    _conflicts: [],
  });
  engine.loadAllLeafDocs = async () => [
    leafDoc("note.md", "chosen", "3-winner"),
    leafDoc("note.md", "", "2-tombstone", { deleted: true, size: 0 }),
  ];
  engine.winnerMatchesChosen = async () => {
    winnerChecks += 1;
    return winnerChecks !== 2;
  };
  const removed = [];
  engine.localDB.instance.remove = async (_id, rev) => { removed.push(rev); };
  const change = { remoteDoc: { _id: id }, path: "note.md" };

  assert.equal(await engine.retireConflictLeaves(change, false, "chosen", new Set(["3-winner", "2-tombstone"])), true);
  assert.deepEqual(removed, []);
  assert.equal(winnerChecks, 4);
});

test("a live revision arriving during retirement stops conflict cleanup", async () => {
  const { engine } = fixture();
  const id = "file:note.md";
  engine.loadPinnedIncomingDoc = async () => ({
    _id: id, _rev: "3-chosen", path: "note.md", content: "chosen", mtime: 3, ctime: 1, size: 6, type: "file", _conflicts: ["2-late"],
  });
  engine.loadAllLeafDocs = async () => [
    leafDoc("note.md", "chosen", "3-chosen"),
    leafDoc("note.md", "unreviewed remote edit", "2-late"),
  ];
  let removed = 0;
  engine.localDB.instance.remove = async () => { removed += 1; };
  await assert.rejects(
    engine.retireConflictLeaves({ remoteDoc: { _id: id }, path: "note.md" }, false, "chosen", new Set(["3-chosen"])),
    /unreviewed database revision arrived/,
  );
  assert.equal(removed, 0);
});

test("one oversized local file cannot abort startup inventory", async () => {
  const { engine, db, files, errors } = fixture();
  db.docs.set("file:existing.md", { ...doc("existing.md", "existing"), _rev: "1" });
  files.set("huge.log", new TFile("huge.log", "", 30 * 1024 * 1024));
  const candidates = await engine.collectStartupCandidates();
  assert.equal(candidates.some((candidate) => candidate.path === "huge.log"), false);
  assert.ok(errors.some((message) => message.includes("huge.log")));
});

test("a new remote revision is not suppressed by an earlier held revision", () => {
  const { engine } = fixture();
  engine.heldIncoming.set("file:note.md", "1-old");
  engine.scheduleIncoming([{ ...doc("note.md", "new"), _rev: "2-new" }]);
  assert.equal(engine.heldIncoming.has("file:note.md"), false);
  assert.equal(engine.pendingIncoming.has("file:note.md"), true);
});

test("an unreviewed leaf that wins the revision election is not adopted", async () => {
  const { engine } = fixture();
  const id = "file:note.md";
  engine.loadPinnedIncomingDoc = async () => ({ _id: id, _rev: "2-zzz", path: "note.md", content: "unreviewed winner", mtime: 3, ctime: 1, size: 16, type: "file" });
  engine.loadAllLeafDocs = async () => [
    leafDoc("note.md", "unreviewed winner", "2-zzz"),
    leafDoc("note.md", "reviewed", "2-aaa"),
  ];
  let removed = 0;
  let published = 0;
  engine.localDB.instance.remove = async () => { removed += 1; };
  engine.publishChosenConflictContent = async () => { published += 1; return true; };
  await assert.rejects(
    engine.retireConflictLeaves({ remoteDoc: { _id: id }, path: "note.md" }, false, "reviewed", new Set(["2-aaa"])),
    /unreviewed database revision arrived/,
  );
  assert.equal(removed, 0);
  assert.equal(published, 0);
});

test("startup same-device offline edit is classified as a safe local push after review", async () => {
  const { engine, db, files } = fixture();
  const id = "file:note.md";
  const file = new TFile("note.md", "offline local edit");
  files.set(file.path, file);
  db.docs.set(id, { ...doc("note.md", "server winner"), _rev: "1", deviceId: "local", deviceName: "local" });
  await engine.saveLastAppliedFingerprint("note.md", "server winner");

  const [candidate] = await engine.collectStartupCandidates();
  assert.equal(candidate.suggested, "keep-local");
  assert.equal(candidate.safeLocalPush, true);
  assert.equal(candidate.requiresReview, true);
  assert.equal(candidate.remoteExists, true);
  assert.equal(await engine.shouldReviewBatch([candidate]), true);

  engine.reviewBatch = async (_title, changes) => engine.acceptAll(changes);
  assert.equal(await engine.applyIncomingChangesWithReview([candidate], "startup"), 1);
  assert.equal(db.docs.get(id).content, "offline local edit");
  assert.equal(engine.readLastAppliedFingerprint("note.md"), await engine.contentFingerprint("offline local edit"));
});

test("startup publishes a new local file only when file history already exists", async () => {
  const { engine, db, files } = fixture();
  db.docs.set("file:existing.md", { ...doc("existing.md", "existing"), _rev: "1" });
  const file = new TFile("new.md", "new local file");
  files.set(file.path, file);

  const candidates = await engine.collectStartupCandidates();
  const candidate = candidates.find((entry) => entry.path === "new.md");
  assert.ok(candidate);
  assert.equal(candidate.remoteExists, false);
  assert.equal(candidate.remoteDeleted, true);
  assert.equal(candidate.suggested, "keep-local");
  assert.equal(candidate.requiresReview, true);
  assert.equal(await engine.applyRemoteChange(candidate), true);
  assert.equal(files.has("new.md"), true, "adopting a missing remote must not delete the local file");

  engine.reviewBatch = async (_title, changes) => engine.acceptAll(changes);
  assert.equal(await engine.applyIncomingChangesWithReview([candidate], "startup"), 1);
  assert.equal(db.docs.get("file:new.md").content, "new local file");
});

test("an empty database history never seeds the vault at startup", async () => {
  const { engine, db, files } = fixture();
  const file = new TFile("new.md", "must not publish");
  files.set(file.path, file);

  assert.deepEqual(await engine.collectStartupCandidates(), []);
  assert.equal(await engine.reconcileVaultAfterStartup(), 0);
  assert.equal(db.writes.length, 0);
  assert.equal(db.docs.size, 0);
});

test("startup treats a remote-only file without adoption history as a server add", async () => {
  const { engine, db, files } = fixture();
  engine.sessionMergeAllowed = true;
  db.docs.set("file:remote-new.md", { ...doc("remote-new.md", "from another device"), _rev: "1" });
  const [candidate] = await engine.collectStartupCandidates();
  assert.equal(candidate.localExists, false);
  assert.equal(candidate.suggested, "keep-remote");
  assert.equal(candidate.requiresReview, false);
  assert.equal(candidate.safeLocalPush, false);
  assert.equal(await engine.reconcileVaultAfterStartup(), 1);
  assert.equal(files.get("remote-new.md").content, "from another device");
});

test("startup local deletion publishes a pinned tombstone after review", async () => {
  const { engine, db } = fixture();
  const id = "file:note.md";
  db.docs.set(id, { ...doc("note.md", "server winner"), _rev: "1", deviceId: "local", deviceName: "local" });
  await engine.saveLastAppliedFingerprint("note.md", "server winner");

  const [candidate] = await engine.collectStartupCandidates();
  assert.equal(candidate.localExists, false);
  assert.equal(candidate.suggested, "keep-local");
  assert.equal(candidate.safeLocalPush, true);
  assert.equal(candidate.requiresReview, true);

  engine.reviewBatch = async (_title, changes) => engine.acceptAll(changes);
  assert.equal(await engine.applyIncomingChangesWithReview([candidate], "startup"), 1);
  assert.equal(db.docs.get(id).deleted, true);
  assert.equal(engine.readLastAppliedFingerprint("note.md"), null);
});

test("startup remote fast-forward replaces the last applied local content", async () => {
  const { engine, db, files } = fixture();
  db.docs.set("file:note.md", { ...doc("note.md", "remote update"), _rev: "1" });
  files.set("note.md", new TFile("note.md", "last applied"));
  await engine.saveLastAppliedFingerprint("note.md", "last applied");
  engine.sessionMergeAllowed = true;

  const [candidate] = await engine.collectStartupCandidates();
  assert.equal(candidate.safeFastForward, true);
  assert.equal(candidate.suggested, "keep-remote");
  assert.equal(candidate.requiresReview, false);
  assert.equal(await engine.reconcileVaultAfterStartup(), 1);
  assert.equal(files.get("note.md").content, "remote update");
  assert.equal(engine.readLastAppliedFingerprint("note.md"), await engine.contentFingerprint("remote update"));
});

test("startup divergence requires review and honors either explicit side choice", async () => {
  const remoteChoice = fixture();
  remoteChoice.db.docs.set("file:note.md", { ...doc("note.md", "remote text"), _rev: "1" });
  remoteChoice.files.set("note.md", new TFile("note.md", "local text"));
  const [keepRemote] = await remoteChoice.engine.collectStartupCandidates();
  assert.equal(keepRemote.requiresReview, true);
  assert.equal(keepRemote.suggested, "keep-local");
  remoteChoice.engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-remote" }],
  });
  assert.equal(await remoteChoice.engine.applyIncomingChangesWithReview([keepRemote], "startup"), 1);
  assert.equal(remoteChoice.files.get("note.md").content, "remote text");

  const localChoice = fixture();
  localChoice.db.docs.set("file:note.md", { ...doc("note.md", "remote text"), _rev: "1" });
  localChoice.files.set("note.md", new TFile("note.md", "local text"));
  const [keepLocal] = await localChoice.engine.collectStartupCandidates();
  localChoice.engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-local" }],
  });
  assert.equal(await localChoice.engine.applyIncomingChangesWithReview([keepLocal], "startup"), 1);
  assert.equal(localChoice.db.docs.get("file:note.md").content, "local text");
});

test("missing last-applied history forces startup review even with session allowance", async () => {
  const { engine, db, files } = fixture();
  engine.sessionMergeAllowed = true;
  db.docs.set("file:note.md", { ...doc("note.md", "remote text"), _rev: "1" });
  files.set("note.md", new TFile("note.md", "local text"));

  const [candidate] = await engine.collectStartupCandidates();
  assert.equal(candidate.requiresReview, true);
  assert.equal(candidate.safeLocalPush, false);
  assert.equal(await engine.shouldReviewBatch([candidate]), true);
});

test("a cancelled startup review does not immediately prompt for dirty paths again", async () => {
  const { engine, db, files } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  db.docs.set("file:note.md", { ...doc("note.md", "remote text"), _rev: "1" });
  let reviews = 0;
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => {
    reviews += 1;
    await engine.onFileChange(new TFile("dirty.md", "changed during startup"));
    return { approved: false, decisions: [] };
  };

  let headState;
  let status;
  try {
    await engine.start();
    await engine.operationQueue;
    headState = engine.getSyncHeadState();
    status = engine.getStatus();
  } finally {
    await engine.stop();
  }

  assert.equal(reviews, 1);
  assert.equal(engine.startupInProgress, false);
  assert.equal(engine.startupDirtyPaths.size, 0);
  assert.equal(headState, "behind");
  assert.equal(status, "paused");
});

test("a pinned startup write aborts if the database winner changed during review", async () => {
  const { engine, db, files } = fixture();
  const id = "file:note.md";
  const file = new TFile("note.md", "offline local edit");
  files.set(file.path, file);
  db.docs.set(id, { ...doc("note.md", "server winner"), _rev: "1", deviceId: "local", deviceName: "local" });
  await engine.saveLastAppliedFingerprint("note.md", "server winner");
  const [candidate] = await engine.collectStartupCandidates();
  assert.equal(candidate.pinnedRev, "1");

  engine.reviewBatch = async () => {
    db.docs.set(id, { ...doc("note.md", "changed remotely"), _rev: "2" });
    return engine.acceptAll([candidate]);
  };
  assert.equal(await engine.applyIncomingChangesWithReview([candidate], "startup"), 0);
  assert.equal(db.docs.get(id).content, "changed remotely");
  assert.equal(file.content, "offline local edit");

  assert.equal(await engine.pushFile(file, { pinnedRev: "1" }), false);
  assert.equal(db.docs.get(id).content, "changed remotely");
  assert.equal(file.content, "offline local edit");
});

test("startup repeats reconciliation once for edits made during the initial review", async () => {
  const { engine, db, files } = fixture();
  db.docs.set("file:existing.md", { ...doc("existing.md", "remote existing"), _rev: "1" });
  const reviewPaths = [];
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async (_title, changes) => {
    reviewPaths.push(changes.map((change) => change.path));
    if (reviewPaths.length === 1) {
      const dirty = new TFile("dirty.md", "dirty local file");
      files.set(dirty.path, dirty);
      await engine.onFileChange(dirty);
    }
    return engine.acceptAll(changes);
  };

  try {
    await engine.start();
    await engine.operationQueue;
  } finally {
    await engine.stop();
  }

  assert.deepEqual(reviewPaths, [["existing.md"], ["dirty.md"]]);
  assert.equal(db.docs.get("file:dirty.md").content, "dirty local file");
  assert.equal(engine.startupDirtyPaths.size, 0);
});

test("a failed startup pull applies no reconciliation candidates", async () => {
  const { engine, db, files, vault } = fixture();
  const file = new TFile("note.md", "local text");
  files.set(file.path, file);
  db.docs.set("file:note.md", { ...doc("note.md", "remote text"), _rev: "1" });
  let reviews = 0;
  engine.shouldReviewBatch = async () => true;
  engine.reviewBatch = async () => { reviews += 1; return { approved: true, decisions: [] }; };
  const originalPull = Replicator.prototype.pullOnce;
  Replicator.prototype.pullOnce = async () => { throw new Error("remote unavailable"); };

  let headState;
  try {
    await engine.start();
    await engine.operationQueue;
    headState = engine.getSyncHeadState();
  } finally {
    Replicator.prototype.pullOnce = originalPull;
    await engine.stop();
  }

  assert.equal(reviews, 0);
  assert.equal(file.content, "local text");
  assert.deepEqual(vault.writes, []);
  assert.equal(headState, "behind");
});

test("a remote-only startup conflict still exposes retained revisions", async () => {
  const { engine, db } = fixture();
  const id = "file:remote-conflict.md";
  db.seedConflict(id, [
    leafDoc("remote-conflict.md", "remote winner", "3-winner"),
    leafDoc("remote-conflict.md", "remote loser", "2-loser"),
  ], "3-winner");
  const [candidate] = await engine.collectStartupCandidates();
  assert.ok(candidate);
  assert.equal(candidate.localExists, false);
  assert.equal(candidate.hasUnresolvedConflicts, true);
  assert.deepEqual(candidate.conflictRevisions.map((revision) => revision.rev), ["3-winner", "2-loser"]);
  assert.equal(typeof candidate.loadConflictPreview, "function");
});

test("retained conflict startup candidates still route to conflict resolution", async () => {
  const { engine, db, files } = fixture();
  const id = "file:note.md";
  files.set("note.md", new TFile("note.md", "local body"));
  db.seedConflict(id, [
    leafDoc("note.md", "server winner", "3-winner"),
    leafDoc("note.md", "chosen loser", "2-loser"),
  ], "3-winner");

  const [candidate] = await engine.collectStartupCandidates();
  assert.equal(candidate.hasUnresolvedConflicts, true);
  assert.equal(candidate.requiresReview, true);
  let resolved = 0;
  const originalResolve = engine.resolveConflictChange.bind(engine);
  engine.resolveConflictChange = async (...args) => { resolved += 1; return await originalResolve(...args); };
  engine.reviewBatch = async () => ({
    approved: true,
    decisions: [{ path: "note.md", selected: true, decision: "keep-remote", conflictRevision: "2-loser" }],
  });

  assert.equal(await engine.applyIncomingChangesWithReview([candidate], "startup"), 1);
  assert.equal(resolved, 1);
  assert.equal(files.get("note.md").content, "chosen loser");
  assert.equal((await db.get(id, { conflicts: true }))._conflicts, undefined);
});

test("startup collection retains only metadata and fingerprints, never plaintext bodies", async () => {
  const { engine, db, files } = fixture();
  db.docs.set("file:remote.md", { ...doc("remote.md", "secret remote body"), _rev: "1" });
  files.set("remote.md", new TFile("remote.md", "secret local body"));
  files.set("local-only.md", new TFile("local-only.md", "secret local-only body"));

  const candidates = await engine.collectStartupCandidates();
  assert.equal(candidates.length, 2);
  const serialized = JSON.stringify(candidates);
  assert.equal(serialized.includes("secret remote body"), false);
  assert.equal(serialized.includes("secret local body"), false);
  assert.equal(serialized.includes("secret local-only body"), false);
  for (const candidate of candidates) {
    assert.equal(candidate.localContent, undefined);
    assert.equal(candidate.remoteContent, undefined);
    assert.equal(candidate.remoteDoc.content, "");
  }
  assert.equal(typeof candidates.find((candidate) => candidate.path === "local-only.md").loadPreview, "function");
});
