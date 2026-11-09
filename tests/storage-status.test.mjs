import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

// Focused regressions for local-only snapshots and replication status.
// Uses a tiny in-memory PouchDB substitute; never touches a live vault or server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const cache = new Map();
const notFound = () => Object.assign(new Error("missing"), { status: 404 });

class FakeReplication extends EventEmitter {
  cancel() { this.cancelled = true; }
  then(resolve, reject) {
    return Promise.resolve({ status: this.cancelled ? "cancelled" : "complete" }).then(resolve, reject);
  }
}

class MockDB {
  constructor(_name, options = {}) {
    this.options = options;
    this.docs = new Map();
    this.queries = [];
    this.writes = [];
    this.getIds = [];
    this.replications = [];
    const replicate = (_remote, options) => {
      const replication = new FakeReplication();
      replication.options = options;
      this.replications.push(replication);
      return replication;
    };
    this.replicate = { to: replicate, from: replicate };
  }

  async get(id) {
    this.getIds.push(id);
    if (!this.docs.has(id)) throw notFound();
    return this.docs.get(id);
  }

  async put(doc) {
    const previous = this.docs.get(doc._id);
    if (previous && previous._rev !== doc._rev) throw Object.assign(new Error("conflict"), { status: 409 });
    this.writes.push(doc._id);
    this.docs.set(doc._id, { ...doc, _rev: `${Number(previous?._rev ?? 0) + 1}` });
    return { ok: true, id: doc._id, rev: this.docs.get(doc._id)._rev };
  }

  async allDocs(options = {}) {
    this.queries.push(options);
    let docs = [...this.docs.entries()]
      .filter(([id]) => !id.startsWith("_local/"))
      .map(([id, doc]) => ({ ...doc, _id: id }))
      .sort((a, b) => a._id.localeCompare(b._id));
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

function loadTS(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const { code } = transformSync(readFileSync(filename, "utf8"), { loader: "ts", format: "cjs", target: "es2020" });
  const require = (specifier) => {
    if (specifier === "./pouchdb") return { PouchDB: MockDB };
    if (specifier.startsWith(".")) return loadTS(path.relative(root, path.resolve(path.dirname(filename), `${specifier}.ts`)));
    return nodeRequire(specifier);
  };
  new Function("require", "module", "exports", code)(require, module, module.exports);
  return module.exports;
}

const { LocalDB } = loadTS("src/sync/LocalDB.ts");
const { Replicator } = loadTS("src/sync/Replicator.ts");
const { CryptoHelper } = loadTS("src/utils/crypto.ts");
const { matchesSelector } = nodeRequire("pouchdb-selector-core");

const snapshotDoc = (id, content = "snapshot content", createdAt = 100) => ({
  _id: `meta:snapshot:${id}`,
  type: "meta",
  metaType: "snapshot",
  createdAt,
  reason: "test",
  sourceDevice: "device",
  files: [{ path: "note.md", existed: true, isBinary: false, content, mtime: 1, ctime: 1 }],
});

const localSnapshotId = (id) => `_local/sink-snapshot:${id}`;

test("local PouchDB bounds device heartbeat revision growth", () => {
  const local = new LocalDB("bounded-heartbeats");
  assert.equal(local.instance.options.auto_compaction, true);
  assert.equal(local.instance.options.revs_limit, 100);
});

test("new snapshots are local-only, summary reads stay metadata-only, and legacy snapshots remain readable", async () => {
  const local = new LocalDB("test");
  const db = local.instance;

  await local.putSnapshotDoc(snapshotDoc("new", "new payload", 200));
  assert.equal(db.docs.has(localSnapshotId("new")), true);
  assert.equal(db.docs.has("meta:snapshot:new"), false);
  assert.equal(db.docs.get(localSnapshotId("new")).files[0].content, "new payload");

  const index = db.docs.get("_local/sink-snapshot-index");
  assert.ok(index);
  assert.equal(index.entries[0].id, "new");
  assert.equal(index.entries[0].fileCount, 1);

  db.getIds = [];
  const summaries = await local.getSnapshotSummaries(10);
  assert.deepEqual(summaries.map((entry) => entry.id), ["new"]);
  assert.equal(db.getIds.includes(localSnapshotId("new")), false);
  assert.equal(db.queries.at(-1).include_docs, false);

  const legacy = snapshotDoc("legacy", "legacy payload", 100);
  db.docs.set(legacy._id, legacy);
  const combined = await local.getSnapshotSummaries(10);
  assert.deepEqual(combined.map((entry) => entry.id), ["new", "legacy"]);
  assert.equal(db.docs.has("meta:snapshot:legacy"), true);

  assert.equal((await local.getSnapshotDoc("new")).files[0].content, "new payload");
  assert.equal((await local.getSnapshotDoc("legacy")).files[0].content, "legacy payload");
});

test("snapshot payloads are encrypted when configured and fail closed", async () => {
  const local = new LocalDB("test");
  const db = local.instance;
  local.configureSnapshotCrypto(new CryptoHelper("test-only-passphrase"));
  await local.putSnapshotDoc(snapshotDoc("encrypted", "top secret"));

  const stored = db.docs.get(localSnapshotId("encrypted"));
  assert.equal(JSON.stringify(stored).includes("top secret"), false);
  assert.equal(stored.files, undefined);
  assert.equal(typeof stored.encryptedFiles, "string");
  assert.equal(typeof stored.encryptedFilesIv, "string");
  assert.equal((await local.getSnapshotDoc("encrypted")).files[0].content, "top secret");

  local.configureSnapshotCrypto(new CryptoHelper("different-passphrase"));
  await assert.rejects(local.getSnapshotDoc("encrypted"));

  local.configureSnapshotCrypto(null);
  await assert.rejects(local.getSnapshotDoc("encrypted"), /passphrase/);

  const failing = new LocalDB("failing");
  failing.configureSnapshotCrypto({ async encrypt() { throw new Error("encryption unavailable"); } });
  await assert.rejects(failing.putSnapshotDoc(snapshotDoc("blocked", "must not persist")), /encryption unavailable/);
  assert.equal(failing.instance.docs.has(localSnapshotId("blocked")), false);
  assert.equal(failing.instance.docs.has("_local/sink-snapshot-index"), false);
  assert.equal(JSON.stringify([...failing.instance.docs.values()]).includes("must not persist"), false);
});

test("snapshot summaries are bounded without deleting older local snapshots", async () => {
  const local = new LocalDB("test");
  const db = local.instance;
  for (let index = 0; index < 55; index++) {
    const id = `s${String(index).padStart(2, "0")}`;
    await local.putSnapshotDoc(snapshotDoc(id, `payload ${index}`, index));
  }

  const index = db.docs.get("_local/sink-snapshot-index");
  assert.ok(index.entries.length <= 50);
  assert.equal(index.entries[0].id, "s54");
  assert.equal(db.docs.has(localSnapshotId("s00")), true);

  const summaries = await local.getSnapshotSummaries(100);
  assert.ok(summaries.length <= 50);
  assert.equal(summaries[0].id, "s54");
});

test("snapshot summaries default to five without deleting older snapshots", async () => {
  const local = new LocalDB("test");
  const db = local.instance;
  for (let index = 0; index < 7; index++) {
    await local.putSnapshotDoc(snapshotDoc(`s${index}`, `payload ${index}`, index));
  }

  assert.deepEqual((await local.getSnapshotSummaries()).map((entry) => entry.id), ["s6", "s5", "s4", "s3", "s2"]);
  assert.equal(db.docs.has(localSnapshotId("s0")), true, "older payload must remain stored");
  assert.equal(db.docs.has(localSnapshotId("s1")), true, "older payload must remain stored");
  assert.equal((await local.getSnapshotSummaries(20)).length, 7);
});

test("snapshot index retries once after a 409 and then lists the saved snapshot", async () => {
  const local = new LocalDB("test");
  const db = local.instance;
  const put = db.put.bind(db);
  let conflicted = false;
  db.put = async (doc) => {
    if (doc._id === "_local/sink-snapshot-index" && !conflicted) {
      conflicted = true;
      throw Object.assign(new Error("conflict"), { status: 409 });
    }
    return put(doc);
  };

  await local.putSnapshotDoc(snapshotDoc("retried", "retry payload", 300));
  assert.equal(conflicted, true);
  assert.equal(db.docs.has(localSnapshotId("retried")), true);
  assert.deepEqual((await local.getSnapshotSummaries(10)).map((entry) => entry.id), ["retried"]);
});

test("persistent snapshot index conflict fails explicitly and keeps the durable snapshot", async () => {
  const local = new LocalDB("test");
  const db = local.instance;
  const put = db.put.bind(db);
  let indexAttempts = 0;
  db.put = async (doc) => {
    if (doc._id === "_local/sink-snapshot-index") {
      indexAttempts += 1;
      throw Object.assign(new Error("conflict"), { status: 409 });
    }
    return put(doc);
  };

  await assert.rejects(
    local.putSnapshotDoc(snapshotDoc("orphan", "durable payload", 400)),
    /saved but its index entry could not be written.*not applied/
  );
  assert.equal(indexAttempts, 3);
  assert.equal(db.docs.has(localSnapshotId("orphan")), true);
  assert.equal(db.docs.has("_local/sink-snapshot-index"), false);
});

test("continuous and one-shot replication filter legacy snapshots and unsupported documents", async () => {
  const local = new MockDB();
  const events = [];
  const replicator = new Replicator({ instance: local }, { instance: new MockDB() }, (event) => events.push(event));
  replicator.start();

  const [continuousPush, continuousPull] = local.replications;
  const acceptsOutbound = (options, document) => options.filter(document);
  const acceptsInbound = (options, document) => options.selector
    ? matchesSelector(document, options.selector)
    : options.filter(document);

  assert.equal(typeof continuousPush.options.filter, "function");
  assert.equal(typeof continuousPull.options.filter, "undefined");
  assert.equal(typeof continuousPull.options.selector, "object");
  assert.equal(continuousPull.options.live, true, "continuous pull must stay live after catch-up");

  for (const options of [continuousPush.options, continuousPull.options]) {
    assert.equal(options.live, true, "both replication directions must stay live after catch-up");
  }

  for (const document of [
    { _id: "file:note.md", type: "file", path: "note.md" },
    { _id: "chunk:a", type: "chunk" },
    { _id: "meta:device:a", type: "meta", metaType: "device" },
    { _id: "file:removed.md", _deleted: true },
    { _id: "chunk:removed", _deleted: true },
    { _id: "meta:device:removed", _deleted: true },
  ]) {
    assert.equal(acceptsOutbound(continuousPush.options, document), true);
    assert.equal(acceptsInbound(continuousPull.options, document), true);
  }

  for (const document of [
    { _id: "meta:snapshot:a", type: "meta", metaType: "snapshot" },
    { _id: "_local/sink-snapshot:a", type: "meta", metaType: "snapshot" },
    { _id: "unknown:a", type: "unknown" },
    { _id: "unknown:removed", _deleted: true },
    { _id: "file:note.md", type: "chunk" },
    { _id: "chunk:a", type: "file" },
    { _id: "meta:device:a", type: "meta", metaType: "snapshot" },
  ]) {
    assert.equal(acceptsOutbound(continuousPush.options, document), false);
    assert.equal(acceptsInbound(continuousPull.options, document), false);
  }

  await replicator.pushOnce();
  const oneShotPush = local.replications.at(-1);
  assert.equal(typeof oneShotPush.options.filter, "function");
  assert.equal(oneShotPush.options.filter({ _id: "meta:snapshot:a", type: "meta", metaType: "snapshot" }), false);
  assert.equal(oneShotPush.options.filter({ _id: "file:note.md", type: "file", path: "note.md" }), true);
  assert.equal(oneShotPush.options.filter({ _id: "file:removed.md", _deleted: true }), true);

  await replicator.pullOnce();
  const oneShotPull = local.replications.at(-1);
  assert.equal(typeof oneShotPull.options.filter, "undefined");
  assert.equal(typeof oneShotPull.options.selector, "object");
  assert.equal(matchesSelector({ _id: "meta:snapshot:a", type: "meta", metaType: "snapshot" }, oneShotPull.options.selector), false);
  assert.equal(matchesSelector({ _id: "file:note.md", type: "file", path: "note.md" }, oneShotPull.options.selector), true);
  assert.equal(matchesSelector({ _id: "chunk:removed", _deleted: true }, oneShotPull.options.selector), true);

  replicator.stop();
});

test("replication status aggregates both directions and never claims connected at start", () => {
  const local = new MockDB();
  const events = [];
  const replicator = new Replicator({ instance: local }, { instance: new MockDB() }, (event) => events.push(event));
  const statuses = () => events.filter((event) => event.type === "status").map((event) => event.status);
  const errors = () => events.filter((event) => event.type === "error");

  replicator.start();
  assert.deepEqual(statuses(), []);

  const [push, pull] = local.replications;
  push.emit("active");
  assert.equal(statuses().at(-1), "syncing");
  push.emit("paused");
  assert.equal(statuses().at(-1), "connected");
  pull.emit("active");
  assert.equal(statuses().at(-1), "syncing");
  pull.emit("paused");
  assert.equal(statuses().at(-1), "connected");

  pull.emit("error", { status: 500, message: "network down" });
  assert.equal(errors().length, 1);
  assert.equal(statuses().at(-1), "error");
  replicator.stop();
  assert.equal(statuses().at(-1), "disconnected");
});

test("a paused event carrying an error is treated as an error, not a connected state", () => {
  const local = new MockDB();
  const events = [];
  const replicator = new Replicator({ instance: local }, { instance: new MockDB() }, (event) => events.push(event));
  const statuses = () => events.filter((event) => event.type === "status").map((event) => event.status);
  replicator.start();
  const [push, pull] = local.replications;
  push.emit("active");
  pull.emit("paused", { status: 500, message: "paused failure" });
  assert.equal(events.filter((event) => event.type === "error").length, 1);
  assert.equal(statuses().at(-1), "error");
  replicator.stop();
});

test("authentication failures are reported with structured messages, and recovery resets backoff", async () => {
  const local = new MockDB();
  const events = [];
  const replicator = new Replicator({ instance: local }, { instance: new MockDB() }, (event) => events.push(event));
  replicator.start();
  const [push] = local.replications;
  const before = events.length;
  push.emit("error", { status: 401, message: "unauthorized" });
  const authError = events.slice(before).find((event) => event.type === "error");
  assert.ok(authError);
  assert.match(String(authError.error), /Authentication failed.*401/);
  assert.equal(replicator.isActive, false);
  assert.equal(replicator.retryTimeout, null, "an auth failure must not leave a retry timer armed");
  const replicationCount = local.replications.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(local.replications.length, replicationCount, "an auth failure must not retry");

  const recovering = new Replicator({ instance: local }, { instance: new MockDB() }, () => {});
  recovering.start();
  recovering.retryDelay = 12000;
  local.replications.at(-2).emit("active");
  assert.equal(recovering.retryDelay, 3000);
  recovering.stop();
});

test("callbacks from a stopped generation are ignored", () => {
  const local = new MockDB();
  const events = [];
  const replicator = new Replicator({ instance: local }, { instance: new MockDB() }, (event) => events.push(event));
  replicator.start();
  const [oldPush, oldPull] = local.replications;
  replicator.stop();
  replicator.start();
  const length = events.length;
  oldPush.emit("change", { docs: [{ _id: "file:a", type: "file", path: "a" }] });
  oldPull.emit("error", { status: 401, message: "stale" });
  oldPush.emit("paused", { status: 500, message: "stale paused" });
  assert.equal(events.length, length);
  assert.equal(replicator.isActive, true);
  replicator.stop();
});
