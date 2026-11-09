#!/usr/bin/env node
// Real end-to-end harness: isolated Obsidian instances + real CouchDB.
// Run: node tests/e2e.mjs
import assert from "node:assert/strict";
import { spawn, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const execFile = promisify(execFileCb);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
const ARTIFACTS = process.env.SINK_E2E_ARTIFACTS || path.join(os.tmpdir(), "sink-e2e-artifacts", RUN);
const OBSIDIAN_BIN = process.env.OBSIDIAN_BIN || "/usr/lib/electron43/electron";
const OBSIDIAN_APP = process.env.OBSIDIAN_APP || "/usr/lib/obsidian/app.asar";
const DISPLAY = process.env.DISPLAY || ":0";
const owned = { procs: new Set(), instances: new Set(), container: null, tmp: null };
const secrets = new Set();
const results = [];
const ONLY = (process.env.SINK_E2E_ONLY || "").split(",").map((value) => value.trim()).filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(value) {
  let text;
  if (value instanceof Error) {
    text = `${value.name || "Error"}: ${value.message || ""}`;
    if (value.status) text += ` (status ${value.status})`;
    if (value.reason) text += ` (${value.reason})`;
  } else text = String(value);
  text = text.replace(/(password|passphrase|Authorization|Basic )[^\s"']*/gi, "$1 [redacted]");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return text;
}

async function until(label, fn, timeout = 20000, interval = 200) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) { last = error; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${redact(last)}` : ""}`);
}

async function withTimeout(label, promise, timeout = 120000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function docker(args) {
  try {
    const { stdout } = await execFile("docker", args, { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    // Never echo the command or error.message: docker run arguments include test credentials.
    const detail = String(error.stderr || "").split("\n").find((line) => line.trim()) || "no stderr";
    throw new Error(`docker ${args[0]} failed (exit ${error.code ?? "unknown"}): ${detail}`);
  }
}

function couchClient(port, user, password) {
  const base = `http://127.0.0.1:${port}`;
  const auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  async function request(rel, { method = "GET", body } = {}) {
    const response = await fetch(base + rel, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`CouchDB ${method} ${rel.split("?")[0]} -> ${response.status}`);
    return text ? JSON.parse(text) : null;
  }
  return { port, base, request };
}

async function startCouch() {
  const name = `sink-e2e-couch-${RUN.slice(-8)}-${randomBytes(2).toString("hex")}`;
  const user = `e2e${randomBytes(6).toString("hex")}`;
  const password = randomBytes(18).toString("hex");
  secrets.add(user);
  secrets.add(password);
  const dbName = `sink-e2e-${randomBytes(4).toString("hex")}`;
  owned.container = name;
  await docker(["run", "-d", "--rm", "--name", name,
    "-e", `COUCHDB_USER=${user}`, "-e", `COUCHDB_PASSWORD=${password}`,
    "-p", "127.0.0.1::5984", "couchdb:3"]);
  const portText = await docker(["port", name, "5984/tcp"]);
  const match = portText.match(/:(\d+)\s*$/m);
  if (!match) throw new Error("Docker did not report a loopback port");
  const port = Number(match[1]);
  const couch = couchClient(port, user, password);
  await until("CouchDB readiness", async () => {
    try {
      const response = await fetch(`${couch.base}/_up`, { headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` } });
      return response.ok;
    } catch { return false; }
  }, 75000, 500);
  await couch.request(`/${encodeURIComponent(dbName)}`, { method: "PUT" });
  // Test-only CORS for the renderer origin. Electron web security stays enabled.
  await couch.request(`/_node/_local/_config/chttpd/enable_cors`, { method: "PUT", body: "true" });
  await couch.request(`/_node/_local/_config/cors/origins`, { method: "PUT", body: "*" });
  await couch.request(`/_node/_local/_config/cors/credentials`, { method: "PUT", body: "true" });
  await couch.request(`/_node/_local/_config/cors/headers`, { method: "PUT", body: "accept, authorization, content-type, origin, referer" });
  await couch.request(`/_node/_local/_config/cors/methods`, { method: "PUT", body: "GET, PUT, POST, HEAD, DELETE, OPTIONS" });
  return { ...couch, dbName, user, password };
}

async function makePlugin(vault, version) {
  const pluginDir = path.join(vault, ".obsidian", "plugins", "sink");
  await fs.mkdir(pluginDir, { recursive: true });
  const externals = [
    "obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands",
    "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
    ...builtinModules.filter((name) => name !== "events"),
  ];
  await esbuild.build({
    entryPoints: [path.join(ROOT, "main.ts")],
    outfile: path.join(pluginDir, "main.js"),
    bundle: true,
    external: externals,
    format: "cjs",
    target: "es2018",
    treeShaking: true,
    sourcemap: "inline",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await fs.copyFile(path.join(ROOT, "manifest.json"), path.join(pluginDir, "manifest.json"));
  await fs.copyFile(path.join(ROOT, "styles.css"), path.join(pluginDir, "styles.css"));
  return { pluginDir, version };
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }
  async open() {
    const parsed = new URL(this.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("CDP endpoint is not loopback");
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error("CDP WebSocket connection failed"));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Page.javascriptDialogOpening") {
        void this.call("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      }
    };
    await this.call("Page.enable");
    return this;
  }
  call(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.socket.close(); } catch {} }
}

async function evaluate(instance, expression, awaitPromise = true) {
  const response = await instance.cdp.call("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "CDP evaluation failed");
  }
  return response.result?.value;
}

async function launchObsidian(label, couch, version, deviceName) {
  const base = path.join(owned.tmp, label);
  const profile = path.join(base, "profile");
  const vault = path.join(base, "vault");
  const dirs = ["home", "config", "data", "cache", "state", "runtime"];
  for (const dir of dirs) await fs.mkdir(path.join(base, dir), { recursive: true, mode: dir === "runtime" ? 0o700 : 0o755 });
  await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await makePlugin(vault, version);
  const settings = {
    serverUrl: `http://127.0.0.1:${couch.port}`, username: couch.user, password: couch.password,
    dbName: couch.dbName, passphrase: couch.passphrase, syncDelay: 50, autoResolveConflicts: true,
    deviceName, deviceId: "", isConfigured: true, syncConfigFolder: false, lastSeenVersion: version,
  };
  await fs.writeFile(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["sink"]));
  await fs.writeFile(path.join(vault, ".obsidian", "plugins", "sink", "data.json"), JSON.stringify(settings));
  const vaultId = randomBytes(8).toString("hex");
  await fs.writeFile(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { [vaultId]: { path: vault, ts: Date.now(), open: true } }, cli: true }));
  const env = {
    ...process.env, HOME: path.join(base, "home"), XDG_CONFIG_HOME: path.join(base, "config"),
    XDG_DATA_HOME: path.join(base, "data"), XDG_CACHE_HOME: path.join(base, "cache"),
    XDG_STATE_HOME: path.join(base, "state"), XDG_RUNTIME_DIR: path.join(base, "runtime"), DISPLAY,
  };
  delete env.WAYLAND_DISPLAY;
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.ELECTRON_RUN_AS_NODE;
  const electronArgs = [OBSIDIAN_APP, `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1", "--ozone-platform=x11", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--lang=en-US"];
  const command = "dbus-run-session";
  const args = existsSync("/usr/bin/dbus-run-session") || existsSync("/usr/sbin/dbus-run-session")
    ? ["--", OBSIDIAN_BIN, ...electronArgs] : null;
  const child = args
    ? spawn(command, args, { env, detached: true, stdio: "ignore" })
    : spawn(OBSIDIAN_BIN, electronArgs, { env, detached: true, stdio: "ignore" });
  owned.procs.add(child.pid);
  const instance = { label, base, profile, vault, child, cdp: null };
  try {
    const port = await until(`${label} DevTools port`, async () => {
      try { return Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
      catch { return 0; }
    }, 45000, 300);
    const target = await until(`${label} renderer target`, async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find((entry) => entry.type === "page" && entry.url.includes("index.html"));
    }, 30000, 300);
    instance.cdp = await new CDP(target.webSocketDebuggerUrl).open();
    await until(`${label} Obsidian app`, () => evaluate(instance, "typeof app !== 'undefined' && !!app.workspace && !!app.vault"), 30000, 250);
    await until(`${label} manifest`, () => evaluate(instance, "!!(app.plugins && app.plugins.manifests && app.plugins.manifests.sink)"), 20000, 200);
    await evaluate(instance, "(async()=>{await app.plugins.setEnable(true); return true})()");
    await until(`${label} Sink plugin`, () => evaluate(instance, "!!(app.plugins.plugins.sink && app.plugins.plugins.sink.getSyncEngine && app.plugins.plugins.sink.settings.isConfigured)"), 30000, 250);
    await until(`${label} Sink engine`, () => evaluate(instance, "!!app.plugins.plugins.sink.getSyncEngine()"), 30000, 250);
    await evaluate(instance, `(()=>{if(!window.__sinkE2EErrors){window.__sinkE2EErrors=[]; const original=console.error.bind(console); console.error=(...args)=>{window.__sinkE2EErrors.push(args.map((value)=>String(value&&value.message||value)).join(' ').slice(0,600)); if(window.__sinkE2EErrors.length>20) window.__sinkE2EErrors.shift(); original(...args)}} window.confirm=()=>true; return true})()`);
    const isolation = await evaluate(instance, "({vault:app.vault.adapter.getBasePath?.()||'', config:app.vault.configDir, plugins:Object.keys(app.plugins.plugins)})");
    assert.equal(path.resolve(isolation.vault), path.resolve(vault), `${label} opened the wrong vault`);
    assert.deepEqual(isolation.plugins, ["sink"], `${label} plugin did not load`);
    instance.settings = settings;
    owned.instances.add(instance);
    return instance;
  } catch (error) {
    instance.cdp?.close();
    throw error;
  }
}

async function setRole(instance, role) {
  return evaluate(instance, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine(); await e.setDeviceRole(e.settings.deviceId, ${JSON.stringify(role)}); return e.settings.deviceId})()`);
}

async function setRoleStable(instance, role) {
  let last;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return await setRole(instance, role); }
    catch (error) { last = error; await sleep(300); }
  }
  throw last;
}

async function createNote(instance, rel, content) {
  return evaluate(instance, `(async()=>{const p=${JSON.stringify(rel)}; const d=p.split('/').slice(0,-1).join('/'); if(d && !app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d); await app.vault.create(p, ${JSON.stringify(content)}); return p})()`);
}

async function modifyNote(instance, rel, content) {
  return evaluate(instance, `(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(rel)}); if(!f) throw new Error('missing '+${JSON.stringify(rel)}); await app.vault.modify(f, ${JSON.stringify(content)}); return f.path})()`);
}

async function createBinary(instance, rel, buffer) {
  const encoded = Buffer.from(buffer).toString("base64");
  return evaluate(instance, `(async()=>{const p=${JSON.stringify(rel)}; const d=p.split('/').slice(0,-1).join('/'); if(d && !app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d); const raw=atob(${JSON.stringify(encoded)}); const bytes=Uint8Array.from(raw, ch=>ch.charCodeAt(0)); await app.vault.createBinary(p, bytes.buffer); return p})()`);
}

async function adapterWrite(instance, rel, content) {
  return evaluate(instance, `(async()=>{const p=${JSON.stringify(rel)}; const d=p.split('/').slice(0,-1).join('/'); if(d) await app.vault.adapter.mkdir(d).catch(()=>{}); await app.vault.adapter.write(p, ${JSON.stringify(content)}); return p})()`);
}

async function readRel(instance, rel) { return fs.readFile(path.join(instance.vault, rel), "utf8"); }

async function sha(instance, rel) {
  return createHash("sha256").update(await fs.readFile(path.join(instance.vault, rel))).digest("hex");
}

async function remoteDoc(couch, id, conflicts = false) {
  try { return await couch.request(`/${encodeURIComponent(couch.dbName)}/${encodeURIComponent(id)}${conflicts ? "?conflicts=true" : ""}`); }
  catch (error) { if (String(error.message).includes("404")) return null; throw error; }
}

async function remoteRevision(couch, id, rev) {
  return await couch.request(`/${encodeURIComponent(couch.dbName)}/${encodeURIComponent(id)}?rev=${encodeURIComponent(rev)}`);
}

async function chooseConflictRevision(instance, rel, rev) {
  return evaluate(instance, `(()=>{const path=[...document.querySelectorAll('.sink-review-file-path')].find(el=>el.textContent.trim()===${JSON.stringify(rel)}); if(!path) return {missing:true}; path.click(); const select=document.querySelector('.sink-review-revision-select'); if(!select) return {missingSelector:true}; if(![...select.options].some(option=>option.value===${JSON.stringify(rev)})) return {missingRevision:true, options:[...select.options].map(option=>option.value)}; select.value=${JSON.stringify(rev)}; select.dispatchEvent(new Event('change',{bubbles:true})); return {selected:select.value};})()`);
}

async function deleteNote(instance, rel) {
  return evaluate(instance, `(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(rel)}); if(!f) throw new Error('missing '+${JSON.stringify(rel)}); await app.vault.delete(f); return true})()`);
}

async function remoteDocs(couch) {
  const data = await couch.request(`/${encodeURIComponent(couch.dbName)}/_all_docs?include_docs=true`);
  return data.rows.map((row) => row.doc).filter(Boolean);
}

async function waitRemote(couch, rel, predicate = () => true, timeout = 25000) {
  return until(`remote ${rel}`, async () => {
    const doc = await remoteDoc(couch, `file:${rel}`);
    return doc && predicate(doc) ? doc : null;
  }, timeout, 250);
}

async function triggerPull(instance) {
  return evaluate(instance, `(()=>{const e=app.plugins.plugins.sink.getSyncEngine(); if(window.__sinkE2EPull && !window.__sinkE2EPull.done) return false; window.__sinkE2EPull={done:false}; e.pullServerToVault().then(n=>{window.__sinkE2EPull={done:true,n}}).catch(err=>{window.__sinkE2EPull={done:true,error:String(err&&err.message||err)}}); return true})()`);
}

async function diagnose(instance) {
  try {
    const state = await evaluate(instance, `(async()=>{const p=app.plugins.plugins.sink; const e=p.getSyncEngine(); let localFiles=null; try{localFiles=(await e.localDB.allDocs({startkey:'file:',endkey:'file:\\uffff'})).rows.length}catch{} return {pull:window.__sinkE2EPull||null,status:e&&e.getStatus?e.getStatus():null,localFiles,engine:!!e,errors:(window.__sinkE2EErrors||[]).slice(-5)}})()`);
    if (state?.pull?.error) state.pull.error = redact(state.pull.error);
    if (state?.errors) state.errors = state.errors.map(redact);
    return state;
  } catch (error) { return { error: redact(error) }; }
}

async function waitPull(instance, timeout = 30000) {
  const state = await until("pull completion", async () => {
    const value = await evaluate(instance, "window.__sinkE2EPull||null");
    return value && value.done ? value : null;
  }, timeout, 200);
  if (state.error) throw new Error(state.error);
  return state.n;
}

async function reviewVisible(instance) {
  return evaluate(instance, "!!document.querySelector('.sink-review-modal .sink-review-file-list')");
}

async function waitReview(instance, timeout = 30000) {
  try {
    await until(`${instance.label} review modal`, () => reviewVisible(instance), timeout, 200);
  } catch (error) {
    const state = await diagnose(instance);
    throw new Error(`${redact(error)} (pull=${JSON.stringify(state.pull)} status=${state.status} localFiles=${state.localFiles} errors=${JSON.stringify(state.errors||[])})`);
  }
  return evaluate(instance, `(()=>{const summary=document.querySelector('.sink-review-summary'); const rows=[...document.querySelectorAll('.sink-review-file-row .sink-review-file-path')].map(el=>el.textContent); return {summary:summary?.textContent||'', count:Number((summary?.textContent||'').match(/^(\\d+) file/)?.[1]||0), rows:rows.length, paths:rows, page:document.querySelector('.sink-review-page-status')?.textContent||''}})()`);
}

async function clickIn(instance, selector, text) {
  return evaluate(instance, `(()=>{const root=document.querySelector(${JSON.stringify(selector)}); if(!root) return false; const button=[...root.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}); if(!button) return false; button.click(); return true})()`);
}

async function cancelReview(instance) {
  assert.equal(await clickIn(instance, ".sink-review-modal", "Cancel"), true, "review cancel button missing");
  await until(`${instance.label} review closed`, async () => !(await reviewVisible(instance)), 15000, 150);
}

async function applyReview(instance, decision = null) {
  if (decision) {
    const changed = await evaluate(instance, `(()=>{const select=document.querySelector('.sink-review-bulk-select'); if(!select) return false; select.value=${JSON.stringify(decision)}; select.dispatchEvent(new Event('change',{bubbles:true})); return true})()`);
    assert.equal(changed, true, "bulk decision control missing");
  }
  assert.equal(await clickIn(instance, ".sink-review-modal", "Apply selected"), true, "review apply button missing");
  await until(`${instance.label} review applied`, async () => !(await reviewVisible(instance)), 20000, 150);
}

async function approvalVisible(instance) {
  return evaluate(instance, "[...document.querySelectorAll('.modal-container')].some(el=>[...el.querySelectorAll('button')].some(b=>b.textContent.includes('Allow for this session')))");
}

async function approvalTitle(instance) {
  return evaluate(instance, "(()=>{const box=[...document.querySelectorAll('.modal-container')].find(el=>[...el.querySelectorAll('button')].some(b=>b.textContent.includes('Allow for this session'))); return box?.querySelector('h2')?.textContent||''})()");
}

async function approveIfAsked(instance, timeout = 4000) {
  try {
    await until(`${instance.label} optional approval`, () => approvalVisible(instance), timeout, 150);
    await approve(instance);
    return true;
  } catch { return false; }
}

async function approve(instance) {
  await until(`${instance.label} approval modal`, () => approvalVisible(instance), 15000, 150);
  assert.equal(await approvalTitle(instance), "Confirm uploads from this device", "approval title is not the publication warning");
  const ok = await evaluate(instance, `(()=>{const button=[...document.querySelectorAll('.modal-container button')].find(b=>b.textContent.includes('Allow for this session')); if(!button) return false; button.click(); return true})()`);
  assert.equal(ok, true, "approval button missing");
  await until(`${instance.label} approval closed`, async () => !(await approvalVisible(instance)), 10000, 150);
}

async function reviewExactly(instance, expected, attempts = 10) {
  const counts = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!(await reviewVisible(instance))) await triggerPull(instance);
    let review;
    try {
      review = await waitReview(instance, 30000);
    } catch (error) {
      const state = await diagnose(instance);
      throw new Error(`${redact(error)} (pull=${JSON.stringify(state.pull)} status=${state.status} localFiles=${state.localFiles})`);
    }
    if (review.count === expected) return { review, counts };
    counts.push(review.count);
    await cancelReview(instance);
    await sleep(300);
  }
  throw new Error(`review batches ${counts.join(",") || "none"} never reached ${expected}`);
}

async function ensureEngine(instance) {
  const state = await evaluate(instance, "(()=>{const e=app.plugins.plugins.sink.getSyncEngine(); return {exists:!!e, stopped:e?.stopped===true}})()");
  if (state.exists && !state.stopped) return false;
  await evaluate(instance, "(async()=>{await app.plugins.plugins.sink.startSync(); return true})()");
  await until(`${instance.label} engine restart`, () => evaluate(instance, "(()=>{const e=app.plugins.plugins.sink.getSyncEngine(); return !!e && e.stopped!==true})()"), 30000, 250);
  return true;
}

async function pauseContinuous(instance) {
  return evaluate(instance, `(()=>{const e=app.plugins.plugins.sink.getSyncEngine(); if(e&&e.replicator) e.replicator.stop(); return true})()`);
}

async function resumeContinuous(instance) {
  return evaluate(instance, `(()=>{const e=app.plugins.plugins.sink.getSyncEngine(); if(e.replicator && !e.replicator.isActive) e.replicator.start(); return true})()`);
}

async function localPaths(instance, rels) {
  return evaluate(instance, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine(); const found=[]; for(const p of ${JSON.stringify(rels)}){try{if(await e.localDB.getByPath(p)) found.push(p)}catch{}} return found})()`);
}

async function pullUntilFiles(instance, rels, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (rels.every((rel) => existsSync(path.join(instance.vault, rel)))) return;
    if (await reviewVisible(instance)) {
      await applyReview(instance);
      await sleep(200);
      continue;
    }
    await triggerPull(instance);
    await sleep(700);
  }
  throw new Error(`files did not arrive: ${rels.filter((rel) => !existsSync(path.join(instance.vault, rel))).join(",")}`);
}

async function applyUntil(instance, rels, decision, expected, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await Promise.all(rels.map((rel) => readRel(instance, rel).catch(() => null)));
    if (current.every((content, index) => content === expected[index])) return;
    if (await reviewVisible(instance)) {
      // An automatic review is not the same operation as the tracked manual pull.
      // Do not wait blindly while a subsequent review may need a real UI decision.
      await applyReview(instance, decision);
    } else {
      await triggerPull(instance);
    }
    await sleep(700);
  }
  const finalContents = await Promise.all(rels.map((rel) => readRel(instance, rel).catch(() => null)));
  if (finalContents.every((content, index) => content === expected[index])) return;
  const state = await evaluate(instance, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine();const files=[];const paths=${JSON.stringify(rels)};const wanted=${JSON.stringify(expected)};for(let i=0;i<paths.length;i++){const p=paths[i];try{const d=await e.localDB.instance.get("file:"+p,{conflicts:true});const clear=await e.decodeIncomingDocForComparison(d,false);const f=app.vault.getAbstractFileByPath(p);const local=f?await app.vault.read(f):null;files.push({path:p,rev:d._rev,device:d.deviceName,sourceId:d.deviceId,currentId:e.settings.deviceId,remoteMatches:clear.content===wanted[i],vaultMatches:local===wanted[i],conflicts:d._conflicts||[],held:e.heldIncoming.has("file:"+p)})}catch{files.push({path:p,missing:true})}}return {files,status:e.getStatus(),head:e.getSyncHeadState(),pending:[...e.pendingIncoming].slice(0,10)}})()`);
  const disk = await Promise.all(rels.map(async (rel, index) => {
    try {
      const value = await readRel(instance, rel);
      return { path: rel, length: value.length, expectedLength: expected[index].length, matches: value === expected[index], normalizedMatches: value.replace(/\r\n/g, "\n") === expected[index], firstDifferences: [...value].map((c, i) => c === expected[index][i] ? null : { offset: i, code: c.codePointAt(0), expected: expected[index].codePointAt(i) }).filter(Boolean).slice(0, 3) };
    } catch (error) { return { path: rel, errorCode: error.code || "unknown" }; }
  }));
  throw new Error(`files did not adopt ${decision}: ${JSON.stringify({ ...state, disk })}`);
}

async function applyTheme(instance, dark) {
  const mode = dark ? "dark" : "light";
  const theme = await evaluate(instance, `(async()=>{let hook=false; try{if(typeof app.changeTheme==='function') await app.changeTheme(${JSON.stringify(mode)});}catch{} if(!document.body.classList.contains('theme-'+${JSON.stringify(mode)})){document.body.classList.remove('theme-light','theme-dark'); document.body.classList.add('theme-'+${JSON.stringify(mode)}); hook=true;} return {mode:${JSON.stringify(mode)},classes:document.body.className,bg:getComputedStyle(document.body).backgroundColor,hook};})()`);
  assert.ok(theme.classes.includes(`theme-${mode}`), `theme ${mode} was not applied`);
  assert.ok(theme.bg && theme.bg !== "rgba(0, 0, 0, 0)", `theme ${mode} background is transparent`);
  return theme;
}

async function capture(instance, name, { width, height, dark }) {
  const theme = await applyTheme(instance, dark);
  await instance.cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(350);
  const layout = await evaluate(instance, `(()=>{const rect=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),bottom:Math.round(r.bottom)}}; const panes=[...document.querySelectorAll('.sink-diff-split .sink-diff-pane')].map(rect); return {viewport:{w:innerWidth,h:innerHeight},footer:rect(document.querySelector('.sink-review-apply')),modal:rect(document.querySelector('.modal.mod-sink-wide')),pager:rect(document.querySelector('.sink-review-pager')),preview:rect(document.querySelector('.sink-review-preview')),panes,bg:getComputedStyle(document.body).backgroundColor}})()`);
  const shot = await instance.cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(ARTIFACTS, `${RUN}-${name}.png`);
  await fs.writeFile(file, Buffer.from(shot.data, "base64"));
  await instance.cdp.call("Emulation.clearDeviceMetricsOverride");
  const checks = [];
  if (!layout.footer || layout.footer.w <= 0 || layout.footer.bottom > layout.viewport.h + 1) checks.push(`${name}: footer not visible ${JSON.stringify(layout.footer)} in ${JSON.stringify(layout.viewport)}`);
  if (layout.footer && layout.modal && layout.footer.bottom > layout.modal.bottom - 4) checks.push(`${name}: footer is clipped by its modal`);
  if (layout.pager && layout.preview && layout.preview.y > layout.pager.y - 10 && layout.pager.bottom > layout.preview.y) checks.push(`${name}: file pager overlaps the preview`);
  if (layout.panes.length !== 2) checks.push(`${name}: expected 2 diff panes, got ${layout.panes.length}`);
  else {
    if (layout.panes.some((pane) => pane.w <= 0 || pane.h <= 0)) checks.push(`${name}: empty diff pane ${JSON.stringify(layout.panes)}`);
    if (Math.abs(layout.panes[0].y - layout.panes[1].y) > 2) checks.push(`${name}: diff panes stacked ${JSON.stringify(layout.panes)}`);
  }
  return { file, theme, layout, checks };
}

async function scenario(name, fn) {
  if (ONLY.length > 0 && !ONLY.some((filter) => name.includes(filter))) {
    results.push({ name, status: "skipped" });
    console.log(`SKIP ${name}`);
    return;
  }
  const started = Date.now();
  try {
    const details = await withTimeout(name, fn(), 120000);
    results.push({ name, status: "pass", durationMs: Date.now() - started, details: details || {} });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: "fail", durationMs: Date.now() - started, error: redact(error) });
    console.log(`FAIL ${name}: ${redact(error)}`);
    // A failed review scenario must not leave its real dialog blocking later tests.
    // Cancellation preserves data; never approve an operation as test cleanup.
    for (const instance of owned.instances) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cancelled = await evaluate(instance, "(()=>{const button=[...document.querySelectorAll('.modal-container button')].find(b=>b.textContent.trim()==='Cancel');if(!button)return false;button.click();return true})()").catch(() => false);
        if (!cancelled) break;
        await sleep(150);
      }
    }
  }
}

async function cleanup() {
  for (const pid of owned.procs) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
  if (owned.procs.size) await sleep(1200);
  for (const pid of owned.procs) {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  if (owned.container) {
    try { await docker(["rm", "-f", owned.container]); } catch (error) { console.error(`cleanup: ${redact(error)}`); }
    owned.container = null;
  }
  if (owned.tmp) {
    try { await fs.rm(owned.tmp, { recursive: true, force: true }); } catch (error) { console.error(`cleanup: ${redact(error)}`); }
    owned.tmp = null;
  }
}

async function main() {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  owned.tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sink-e2e-run-"));
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
  const version = manifest.version;
  const couch = await startCouch();
  couch.passphrase = randomBytes(24).toString("base64url");
  secrets.add(couch.passphrase);
  let A, B;
  try { A = await launchObsidian("obsidian-a", couch, version, "e2e-primary"); }
  catch (error) { throw new Error(`launch A: ${redact(error)}`); }
  try { B = await launchObsidian("obsidian-b", couch, version, "e2e-secondary"); }
  catch (error) { throw new Error(`launch B: ${redact(error)}`); }
  await sleep(800);
  try { await setRoleStable(A, "primary"); await setRoleStable(B, "secondary"); }
  catch (error) { throw new Error(`role setup: ${redact(error)}`); }
  await pauseContinuous(B);

  const all12 = Array.from({ length: 12 }, (_, index) => `review/file-${String(index + 1).padStart(2, "0")}.md`);
  const screenshots = [];

  await scenario("12-file pull review: count, cancel, confirm", async () => {
    await ensureEngine(A);
    await ensureEngine(B);
    const styleErrors = [];
    const contents = new Map(all12.map((rel, index) => [rel, `review payload ${index + 1}\n`]));
    for (const rel of all12) await createNote(A, rel, contents.get(rel));
    for (const rel of all12) await waitRemote(couch, rel);
    const exact = await reviewExactly(B, 12);
    const summary = exact.review;
    assert.equal(summary.count, 12, `review count was ${summary.count}`);
    assert.equal(summary.rows, 12, `visible rows were ${summary.rows}`);
    assert.equal(await evaluate(B, "document.querySelectorAll('.sink-diff-split .sink-diff-pane').length"), 0, "diff opened by default");
    assert.equal(await evaluate(B, "document.querySelector('.sink-review-preview-content')?.textContent.includes('Open a file row')"), true, "collapsed diff hint missing");
    assert.equal(await evaluate(B, "(()=>{const row=document.querySelector('.sink-review-file-row'); row.querySelector('.sink-review-file-meta').click(); return true})()"), true);
    await until("review diff preview", () => evaluate(B, "document.querySelectorAll('.sink-diff-split .sink-diff-pane').length===2"), 15000, 200);
    for (const [name, size, dark] of [["desktop-light", [1280, 900], false], ["desktop-dark", [1280, 900], true], ["narrow-light", [600, 900], false], ["narrow-dark", [600, 900], true]]) {
      screenshots.push(await capture(B, `review-${name}`, { width: size[0], height: size[1], dark }));
    }
    styleErrors.push(...screenshots.flatMap((shot) => shot.checks));
    const lightShot = screenshots.find((shot) => shot.theme.mode === "light");
    const darkShot = screenshots.find((shot) => shot.theme.mode === "dark");
    if (!lightShot || !darkShot) styleErrors.push("light and dark screenshots were not captured");
    else if (lightShot.theme.bg === darkShot.theme.bg) styleErrors.push("light and dark themes rendered the same background");
    await cancelReview(B);
    assert.equal(all12.filter((rel) => existsSync(path.join(B.vault, rel))).length, 0, "cancel wrote files");
    let confirmed = 0;
    for (let attempt = 0; attempt < 6 && all12.some((rel) => !existsSync(path.join(B.vault, rel))); attempt++) {
      if (!(await reviewVisible(B))) await triggerPull(B);
      const batch = await waitReview(B);
      confirmed += batch.count;
      await applyReview(B);
      await waitPull(B).catch(() => 0);
    }
    assert.equal(confirmed, 12, `confirmed ${confirmed} reviewed files`);
    for (const rel of all12) {
      assert.equal(await readRel(B, rel), contents.get(rel), `content mismatch for ${rel}`);
      assert.equal(await sha(A, rel), await sha(B, rel), `hash mismatch for ${rel}`);
    }
    const snapshots = await evaluate(B, "app.plugins.plugins.sink.getSyncEngine().listSnapshots()");
    const remote = await remoteDocs(couch);
    assert.ok(snapshots.length > 0, "local snapshot was not created");
    assert.equal(remote.some((doc) => doc.type === "meta" && doc.metaType === "snapshot"), false, "snapshot reached CouchDB");
    assert.equal(remote.some((doc) => String(doc._id).startsWith("_local/sink-snapshot:")), false, "local snapshot index reached CouchDB");
    await resumeContinuous(B);
    if (styleErrors.length) {
      results.push({ name: "review layout/style evidence", status: "fail", durationMs: 0, error: styleErrors.join("; "), details: { screenshots } });
      console.log(`FAIL review layout/style evidence: ${styleErrors.join("; ")}`);
    } else {
      results.push({ name: "review layout/style evidence", status: "pass", durationMs: 0, details: { screenshots } });
      console.log("PASS review layout/style evidence");
    }
    return { count: summary.count, confirmed, smallerBatchesDiscarded: exact.counts, hashesMatched: 12, localSnapshots: snapshots.length, screenshots, styleErrors };
  });

  await scenario("secondary device authorization once", async () => {
    await ensureEngine(B);
    await createNote(B, "auth/secondary-1.md", "secondary write 1\n");
    await until("approval modal for secondary", () => approvalVisible(B), 20000, 150);
    assert.equal(await remoteDoc(couch, "file:auth/secondary-1.md"), null, "secondary wrote before approval");
    await approve(B);
    await waitRemote(couch, "auth/secondary-1.md");
    await createNote(B, "auth/secondary-2.md", "secondary write 2\n");
    await waitRemote(couch, "auth/secondary-2.md");
    await sleep(800);
    assert.equal(await approvalVisible(B), false, "secondary asked for approval again");
    return { approvedOnce: true, files: 2 };
  });

  const divergent = ["diverge/one.md", "diverge/two.md", "diverge/three.md"];
  await scenario("divergent edits preserved until explicit side decision", async () => {
    await ensureEngine(A);
    await ensureEngine(B);
    for (const rel of divergent) await createNote(A, rel, `base ${rel}\n`);
    for (const rel of divergent) await waitRemote(couch, rel);
    await pullUntilFiles(B, divergent);
    for (const rel of divergent) assert.ok(existsSync(path.join(B.vault, rel)), `B missing base ${rel}`);
    await evaluate(B, "(async()=>{await app.plugins.plugins.sink.stopSync(); return true})()");
    await until("B engine stopped", async () => !(await evaluate(B, "!!app.plugins.plugins.sink.getSyncEngine()")), 20000, 200);
    for (const rel of divergent) await modifyNote(B, rel, `local ${rel}\n`);
    const beforeServerEdits = new Map();
    for (const rel of divergent) beforeServerEdits.set(rel, (await remoteDoc(couch, `file:${rel}`))._rev);
    for (const rel of divergent) await modifyNote(A, rel, `server ${rel}\n`);
    // Await an actual new revision, not a timestamp that also matches the base.
    for (const rel of divergent) await waitRemote(couch, rel, (doc) => doc._rev !== beforeServerEdits.get(rel));
    for (const rel of divergent) {
      assert.equal(await readRel(B, rel), `local ${rel}\n`, "B local edit was lost before decision");
      assert.equal(await readRel(A, rel), `server ${rel}\n`, "A server edit was lost before decision");
      assert.notEqual(await sha(A, rel), await sha(B, rel), "divergent copies became identical before decision");
    }
    await evaluate(B, "(async()=>{await app.plugins.plugins.sink.startSync(); return true})()");
    await until("B engine restarted", () => evaluate(B, "!!app.plugins.plugins.sink.getSyncEngine()"), 30000, 250);
    await until("B startup reconciliation", () => evaluate(B, "(()=>{const e=app.plugins.plugins.sink.getSyncEngine(); return !!e && (!e.startupInProgress || !!document.querySelector('.sink-review-modal'))})()"), 30000, 200);
    const exact = await reviewExactly(B, 3);
    const review = exact.review;
    assert.equal(review.count, 3, `divergent review counted ${review.count}`);
    await cancelReview(B);
    for (const rel of divergent) assert.equal(await readRel(B, rel), `local ${rel}\n`, "cancel changed local divergent copy");
    for (const rel of divergent) assert.equal(await readRel(A, rel), `server ${rel}\n`, "cancel changed server divergent copy");
    await triggerPull(B);
    await waitReview(B);
    await applyReview(B, "keep-local");
    await approve(B).catch(() => {});
    await resumeContinuous(B);
    for (const rel of divergent) await waitRemote(couch, rel, (doc) => doc.deviceName === "e2e-secondary");
    await applyUntil(A, divergent, "keep-remote", divergent.map((rel) => `local ${rel}\n`));
    for (const rel of divergent) {
      assert.equal(await readRel(A, rel), `local ${rel}\n`, "server did not adopt explicit local decision");
      assert.equal(await sha(A, rel), await sha(B, rel), "vaults diverged after explicit decision");
    }
    return { preservedBeforeDecision: 3, explicitDecision: "keep-local", hashesMatched: 3 };
  });

  await scenario("reconnect and catch-up", async () => {
    await ensureEngine(A);
    await ensureEngine(B);
    await evaluate(B, "(async()=>{await app.plugins.plugins.sink.stopSync(); return true})()");
    await until("B stopped for catch-up", async () => !(await evaluate(B, "!!app.plugins.plugins.sink.getSyncEngine()")), 20000, 200);
    await createNote(A, "catchup/while-offline.md", "written while B was offline\n");
    await waitRemote(couch, "catchup/while-offline.md");
    assert.equal(existsSync(path.join(B.vault, "catchup/while-offline.md")), false, "B received file while stopped");
    await evaluate(B, "(async()=>{await app.plugins.plugins.sink.startSync(); return true})()");
    await until("B caught up", () => evaluate(B, "!!app.plugins.plugins.sink.getSyncEngine()"), 30000, 250);
    await until("catch-up file", () => existsSync(path.join(B.vault, "catchup/while-offline.md")), 30000, 250);
    assert.equal(await readRel(B, "catchup/while-offline.md"), "written while B was offline\n");
    const status = await evaluate(B, "app.plugins.plugins.sink.getSyncEngine().getStatus()");
    assert.ok(["connected", "syncing", "paused"].includes(status), `unexpected status ${status}`);
    return { caughtUp: true, status };
  });

  await scenario("startup reconciliation after offline local edits", async () => {
    await ensureEngine(A);
    await ensureEngine(B);
    const editPath = "startup/edit.md";
    const deletePath = "startup/delete.md";
    const divergentPath = "startup/divergent.md";
    const newPath = "startup/new.md";
    for (const rel of [editPath, deletePath, divergentPath]) await createNote(A, rel, `base ${rel}\n`);
    for (const rel of [editPath, deletePath, divergentPath]) await waitRemote(couch, rel);
    await pullUntilFiles(B, [editPath, deletePath, divergentPath]);

    await evaluate(B, "(async()=>{await app.plugins.plugins.sink.stopSync(); return true})()");
    await until("B stopped for startup reconciliation", async () => !(await evaluate(B, "!!app.plugins.plugins.sink.getSyncEngine()")), 20000, 200);
    await modifyNote(B, editPath, `offline local edit ${editPath}\n`);
    await createNote(B, newPath, `offline new file ${newPath}\n`);
    await deleteNote(B, deletePath);
    await modifyNote(B, divergentPath, `offline divergent local ${divergentPath}\n`);
    const beforeDivergentRev = (await remoteDoc(couch, `file:${divergentPath}`))._rev;
    await modifyNote(A, divergentPath, `remote divergent server ${divergentPath}\n`);
    try {
      await waitRemote(couch, divergentPath, (doc) => doc._rev !== beforeDivergentRev);
    } catch (error) {
      const diagnostic = await evaluate(A, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine(); const f=app.vault.getAbstractFileByPath(${JSON.stringify(divergentPath)}); let db=null; try{db=await e.localDB.instance.get(${JSON.stringify(`file:${divergentPath}`)},{conflicts:true})}catch(err){db={error:err.status||err.message}} return {local:f?await app.vault.read(f):null,db:{rev:db._rev,content:db.content,conflicts:db._conflicts,device:db.deviceName,error:db.error},engine:!!e,stopped:e?.stopped,status:e?.getStatus?.(),head:e?.getSyncHeadState?.(),replicator:e?.replicator?{active:e.replicator.isActive,push:e.replicator.pushState,pull:e.replicator.pullState,retry:e.replicator.retryDelay}:null,debounce:e?[...e.debounceTimers.keys()]:[],review:!!document.querySelector('.sink-review-modal'),pending:e?[...e.pendingIncoming]:[],processing:e?[...e.processing.keys()]:[],errors:(window.__sinkE2EErrors||[]).slice(-3)}})()`);
      throw new Error(`${error.message}: ${JSON.stringify({ diagnostic })}`);
    }

    const beforeApply = new Map();
    for (const rel of [editPath, deletePath, divergentPath, newPath]) {
      beforeApply.set(rel, (await remoteDoc(couch, `file:${rel}`))?._rev ?? null);
    }
    await evaluate(B, "(async()=>{await app.plugins.plugins.sink.startSync(); return true})()");
    await until("B startup engine", () => evaluate(B, "!!app.plugins.plugins.sink.getSyncEngine()"), 30000, 250);
    await pauseContinuous(B);
    const review = await waitReview(B, 40000);
    assert.equal(review.count, 4, `startup review counted ${review.count}`);
    assert.deepEqual([...review.paths].sort(), [editPath, deletePath, divergentPath, newPath].sort(), `startup review paths ${JSON.stringify(review.paths)}`);
    await applyReview(B, "keep-local");
    await approveIfAsked(B);
    await resumeContinuous(B);

    try {
      await until("startup local edit remote", () => waitRemote(couch, editPath, (doc) => doc._rev !== beforeApply.get(editPath) && doc.deviceName === "e2e-secondary"), 30000, 250);
    } catch (error) {
      const diagnostic = await evaluate(B, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine(); const f=app.vault.getAbstractFileByPath(${JSON.stringify(editPath)}); let db=null; try{db=await e.localDB.instance.get(${JSON.stringify(`file:${editPath}`)},{conflicts:true})}catch(err){db={error:err.status||err.message}} return {local:f?await app.vault.read(f):null,db:{rev:db._rev,device:db.deviceName,deleted:db.deleted,error:db.error},status:e?.getStatus?.(),head:e?.getSyncHeadState?.(),lastApplyIncomplete:e?.lastApplyIncomplete,reviewCancelled:e?.reviewCancelled,deferred:e?[...e.deferredReviewMarkers.keys()]:[],secondaryApproved:e?.secondaryPushApproved,review:!!document.querySelector('.sink-review-modal'),approval:[...document.querySelectorAll('.modal-container button')].some(b=>b.textContent.includes('Allow for this session')),pending:e?[...e.pendingIncoming]:[],held:e?[...e.heldIncoming.keys()]:[],processing:e?[...e.processing.keys()]:[],errors:(window.__sinkE2EErrors||[]).slice(-5)}})()`);
      const remote = await remoteDoc(couch, `file:${editPath}`, true);
      throw new Error(`${error.message}: ${JSON.stringify({ diagnostic, beforeRev: beforeApply.get(editPath), remote: { rev: remote?._rev, device: remote?.deviceName, deleted: remote?._deleted } })}`);
    }
    await until("startup new file remote", () => waitRemote(couch, newPath, (doc) => !!doc && doc.deviceName === "e2e-secondary"), 30000, 250);
    await until("startup deletion remote", async () => {
      const doc = await remoteDoc(couch, deletePath);
      return !doc || doc._deleted === true;
    }, 30000, 250);
    try {
      await until("startup divergence remote", () => waitRemote(couch, divergentPath, (doc) => doc._rev !== beforeApply.get(divergentPath) && doc.deviceName === "e2e-secondary"), 30000, 250);
    } catch (error) {
      const diagnostic = await evaluate(B, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine(); const f=app.vault.getAbstractFileByPath(${JSON.stringify(divergentPath)}); let db=null; try{db=await e.localDB.instance.get(${JSON.stringify(`file:${divergentPath}`)},{conflicts:true})}catch(err){db={error:err.status||err.message}} return {local:f?await app.vault.read(f):null,db:{rev:db._rev,content:db.content,conflicts:db._conflicts,device:db.deviceName,error:db.error},status:e.getStatus(),head:e.getSyncHeadState(),review:!!document.querySelector('.sink-review-modal'),pending:[...e.pendingIncoming],held:[...e.heldIncoming.keys()],errors:(window.__sinkE2EErrors||[]).slice(-3)}})()`);
      const remote = await remoteDoc(couch, `file:${divergentPath}`, true);
      throw new Error(`${error.message}: ${JSON.stringify({ diagnostic, remote: { rev: remote?._rev, content: remote?.content, conflicts: remote?._conflicts } })}`);
    }
    await until("startup local files", () => existsSync(path.join(B.vault, editPath)) && existsSync(path.join(B.vault, newPath)) && !existsSync(path.join(B.vault, deletePath)), 20000, 200);
    assert.equal(await readRel(B, editPath), `offline local edit ${editPath}\n`);
    assert.equal(await readRel(B, newPath), `offline new file ${newPath}\n`);
    assert.equal(await readRel(B, divergentPath), `offline divergent local ${divergentPath}\n`);
    await resumeContinuous(B);
    for (let attempt = 0; attempt < 4 && await reviewVisible(A); attempt++) {
      await applyReview(A, "keep-remote");
      await approveIfAsked(A);
      await resumeContinuous(A);
      await sleep(400);
    }
    try {
      await until("A adopts startup divergence", () => evaluate(A, `(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(divergentPath)}); return !!f && (await app.vault.read(f))===${JSON.stringify(`offline divergent local ${divergentPath}\n`)}})()`), 40000, 250);
    } catch (error) {
      const diagnostic = await evaluate(A, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine(); const f=app.vault.getAbstractFileByPath(${JSON.stringify(divergentPath)}); let db=null; try{db=await e.localDB.instance.get(${JSON.stringify(`file:${divergentPath}`)},{conflicts:true})}catch(err){db={error:err.status||err.message}} return {local:f?await app.vault.read(f):null,db:{rev:db._rev,device:db.deviceName,conflicts:db._conflicts,deleted:db.deleted,error:db.error},status:e?.getStatus?.(),head:e?.getSyncHeadState?.(),review:!!document.querySelector('.sink-review-modal'),pending:e?[...e.pendingIncoming]:[],held:e?[...e.heldIncoming.keys()]:[],processing:e?[...e.processing.keys()]:[],lastApplied:e?.readLastAppliedFingerprint?.(${JSON.stringify(divergentPath)}),errors:(window.__sinkE2EErrors||[]).slice(-5)}})()`);
      throw new Error(`${error.message}: ${JSON.stringify({ diagnostic })}`);
    }
    return { reviewed: review.count, localEdit: true, newFile: true, deletion: true, divergence: true, oneReview: true };
  });

  await scenario("encrypted >64KiB chunk transfer", async () => {
    await ensureEngine(A);
    await ensureEngine(B);
    const marker = "sink-e2e-plaintext-marker-";
    const content = (marker + "0123456789abcdef\n").repeat(6000);
    assert.ok(Buffer.byteLength(content) > 65536, "chunk fixture is too small");
    await createNote(A, "chunks/large.md", content);
    const doc = await waitRemote(couch, "chunks/large.md", (entry) => Array.isArray(entry.chunks) && entry.chunks.length > 1);
    assert.ok(doc.iv, "parent document was not encrypted");
    assert.ok(doc.chunks.length > 1, "document was not chunked");
    const remote = await remoteDocs(couch);
    const chunks = remote.filter((entry) => String(entry._id).startsWith("chunk:"));
    assert.ok(chunks.length > 1, "chunk documents missing from CouchDB");
    assert.equal(chunks.every((entry) => entry.iv), true, "chunk was left unencrypted");
    assert.equal(JSON.stringify(remote).includes(marker), false, "plaintext marker reached CouchDB");
    await until("B large file", () => existsSync(path.join(B.vault, "chunks/large.md")), 40000, 250);
    assert.equal(await sha(A, "chunks/large.md"), await sha(B, "chunks/large.md"), "chunked file hash mismatch");
    return { chunks: doc.chunks.length, bytes: Buffer.byteLength(content), encrypted: true };
  });

  await scenario("unchanged binary attachments do not reappear after restart", async () => {
    await ensureEngine(A);
    await ensureEngine(B);
    const smallPath = "800 Attachments/e2e-stable-small.png";
    const largePath = "800 Attachments/e2e-stable-chunked.png";
    const small = Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251));
    const large = Buffer.from(Array.from({ length: 90000 }, (_, index) => (index * 17) % 251));
    await createBinary(A, smallPath, small);
    await createBinary(A, largePath, large);
    await waitRemote(couch, smallPath);
    const largeDoc = await waitRemote(couch, largePath, (doc) => Array.isArray(doc.chunks) && doc.chunks.length > 1);
    assert.ok(largeDoc.iv, "chunked binary parent was not encrypted");
    await until("B stable small attachment", () => existsSync(path.join(B.vault, smallPath)), 40000, 250);
    await until("B stable chunked attachment", () => existsSync(path.join(B.vault, largePath)), 40000, 250);
    assert.equal(await sha(A, smallPath), await sha(B, smallPath), "small attachment hash mismatch");
    assert.equal(await sha(A, largePath), await sha(B, largePath), "chunked attachment hash mismatch");

    for (let attempt = 0; attempt < 2; attempt++) {
      await evaluate(B, "(async()=>{await app.plugins.plugins.sink.stopSync(); await app.plugins.plugins.sink.startSync(); return true})()");
      await until(`B binary restart ${attempt + 1}`, () => evaluate(B, "(()=>{const e=app.plugins.plugins.sink.getSyncEngine(); return !!e && !e.startupInProgress})()"), 45000, 250);
      if (await reviewVisible(B)) {
        const review = await waitReview(B);
        assert.equal(review.paths.includes(smallPath), false, `unchanged small attachment reappeared: ${JSON.stringify(review.paths)}`);
        assert.equal(review.paths.includes(largePath), false, `unchanged chunked attachment reappeared: ${JSON.stringify(review.paths)}`);
        await cancelReview(B);
      }
      assert.equal(await sha(A, smallPath), await sha(B, smallPath));
      assert.equal(await sha(A, largePath), await sha(B, largePath));
    }
    return { restarts: 2, inlineBytes: small.length, chunkedBytes: large.length, recurringRows: 0 };
  });

  await scenario("snapshot display is limited to five without deleting older snapshots", async () => {
    await ensureEngine(B);
    const ids = await evaluate(B, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine();const p=app.vault.getFiles()[0]?.path;if(!p) throw new Error('no vault file for snapshot fixture');const ids=[];for(let i=0;i<7;i++){ids.push(await e.createSnapshot('e2e retention '+i,[p],'e2e'))}return ids})()`);
    assert.equal(ids.length, 7);
    const shown = await evaluate(B, "app.plugins.plugins.sink.getSyncEngine().listSnapshots()");
    assert.equal(shown.length, 5, `shown ${shown.length} snapshots`);
    assert.deepEqual([...shown.map((entry) => entry.id)].sort(), [...ids.slice(-5)].sort());
    const stored = await evaluate(B, "app.plugins.plugins.sink.getSyncEngine().listSnapshots(50)");
    assert.ok(stored.length >= 7, `stored ${stored.length} snapshots`);
    assert.deepEqual([...stored.map((entry) => entry.id)].filter((id) => ids.includes(id)).sort(), [...ids].sort());
    const present = await evaluate(B, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine();return await Promise.all(${JSON.stringify(ids)}.map(async id=>{try{await e.localDB.instance.get('_local/sink-snapshot:'+id);return true}catch(err){return false}}))})()`);
    assert.deepEqual(present, ids.map(() => true));
    return { created: 7, shown: shown.length, stored: stored.length, deleted: 0 };
  });

  await scenario("targeted inbound selector: legacy snapshot excluded, files/chunks/devices/tombstones pass, live updates", async () => {
    await ensureEngine(A);
    await ensureEngine(B);
    await pauseContinuous(B);
    const db = `/${encodeURIComponent(couch.dbName)}`;
    const snapshotId = "meta:snapshot:legacy-2026-sentinel";
    await couch.request(`${db}/${encodeURIComponent(snapshotId)}`, { method: "PUT", body: {
      type: "meta", metaType: "snapshot", createdAt: 1, reason: "legacy sentinel", sourceDevice: "legacy",
      files: [{ path: "sentinel/never-transfer.md", existed: true, isBinary: false, content: "SENTINEL-LEGACY-SNAPSHOT" }],
    }});
    await couch.request(`${db}/${encodeURIComponent("chunk:selector-chunk-1")}`, { method: "PUT", body: {
      type: "chunk", data: "selector chunk body\n",
    }});
    await couch.request(`${db}/${encodeURIComponent("file:selector/chunked.md")}`, { method: "PUT", body: {
      path: "selector/chunked.md", content: "", chunks: ["chunk:selector-chunk-1"], mtime: Date.now(), ctime: Date.now(),
      size: 20, type: "file", deviceName: "e2e-primary",
    }});
    await couch.request(`${db}/${encodeURIComponent("meta:device:selector-device")}`, { method: "PUT", body: {
      type: "meta", metaType: "device", deviceId: "selector-device", deviceName: "selector-device", role: "secondary",
      vaultName: "selector-vault", lastSeen: Date.now(), pluginVersion: version,
    }});
    const tombstoneId = "file:selector/removed.md";
    const created = await couch.request(`${db}/${encodeURIComponent(tombstoneId)}`, { method: "PUT", body: {
      path: "selector/removed.md", content: "removed\n", mtime: Date.now(), ctime: Date.now(), size: 8, type: "file", deviceName: "e2e-primary",
    }});
    await couch.request(`${db}/${encodeURIComponent(tombstoneId)}?rev=${encodeURIComponent(created.rev)}`, { method: "DELETE" });
    await triggerPull(B);
    await waitPull(B).catch(() => 0);
    await until("selector chunked file", () => existsSync(path.join(B.vault, "selector/chunked.md")), 25000, 200);
    assert.equal(await readRel(B, "selector/chunked.md"), "selector chunk body\n", "chunk selector payload mismatch");
    const selectorState = await evaluate(B, `(async()=>{const e=app.plugins.plugins.sink.getSyncEngine(); const one=async id=>{try{const d=await e.localDB.get(id); return {ok:true,deleted:!!d._deleted,type:d.type,metaType:d.metaType||null}}catch(err){return {ok:false,status:err.status||null}}}; const tomb=(await e.localDB.instance.allDocs({keys:[${JSON.stringify(tombstoneId)}], include_docs:false})).rows[0]; return {legacy:await one(${JSON.stringify(snapshotId)}),chunk:await one("chunk:selector-chunk-1"),device:await one("meta:device:selector-device"),tombstone:tomb}})()`);
    assert.equal(selectorState.legacy.ok, false, "legacy snapshot crossed the inbound selector");
    assert.equal(selectorState.legacy.status, 404, "legacy snapshot lookup did not return 404");
    assert.equal(selectorState.chunk.ok, true, "chunk did not replicate");
    assert.equal(selectorState.chunk.type, "chunk", "selected chunk has wrong type");
    assert.equal(selectorState.device.ok, true, "device meta did not replicate");
    assert.equal(selectorState.tombstone?.value?.deleted, true, "supported tombstone did not replicate");
    await resumeContinuous(B);
    await createNote(A, "selector/live.md", "live selector update\n");
    await until("live selector update", () => existsSync(path.join(B.vault, "selector/live.md")), 30000, 250);
    assert.equal(await readRel(B, "selector/live.md"), "live selector update\n");
    return { legacyExcluded: true, chunk: true, device: true, tombstone: true, liveUpdate: true };
  });

  await scenario("real CouchDB conflict revisions are reviewed and resolved", async () => {
    await ensureEngine(A);
    await ensureEngine(B);
    await evaluate(B, "(async()=>{await app.plugins.plugins.sink.stopSync(); return true})()");
    await until("B stopped for conflicts", async () => !(await evaluate(B, "!!app.plugins.plugins.sink.getSyncEngine()")), 20000, 200);
    const paths = ["conflict/c1.md", "conflict/c2.md", "conflict/c3.md"];
    for (const [index, rel] of paths.entries()) {
      const id = `file:${rel}`;
      const db = `/${encodeURIComponent(couch.dbName)}`;
      const first = await couch.request(`${db}/${encodeURIComponent(id)}`, { method: "PUT", body: {
        path: rel, content: `base ${index}\n`, mtime: Date.now(), ctime: Date.now(), size: 7, type: "file", deviceName: "e2e-primary",
      } });
      await couch.request(`${db}/${encodeURIComponent(id)}`, { method: "PUT", body: {
        _rev: first.rev, path: rel, content: `main branch ${index}\n`, mtime: Date.now(), ctime: Date.now(), size: 16, type: "file", deviceName: "e2e-primary",
      } });
      const leaf = randomBytes(16).toString("hex");
      const parent = first.rev.split("-")[1];
      await couch.request(`${db}/_bulk_docs`, { method: "POST", body: {
        new_edits: false,
        docs: [{ _id: id, _rev: `2-${leaf}`, _revisions: { start: 2, ids: [leaf, parent] },
          path: rel, content: `conflict branch ${index}\n`, mtime: Date.now(), ctime: Date.now(), size: 19, type: "file", deviceName: "e2e-secondary" }],
      }});
      const conflicted = await remoteDoc(couch, id, true);
      assert.ok(conflicted._conflicts?.length > 0, `no CouchDB conflict branch for ${rel}`);
    }

    let before = new Map();
    for (const rel of paths) before.set(rel, await remoteDoc(couch, `file:${rel}`, true));
    const selectedRev = before.get(paths[0])._conflicts[0];
    const selectedLeaf = await remoteRevision(couch, `file:${paths[0]}`, selectedRev);

    await evaluate(B, "(async()=>{await app.plugins.plugins.sink.startSync(); return true})()");
    await until("B conflict engine", () => evaluate(B, "!!app.plugins.plugins.sink.getSyncEngine()"), 30000, 250);
    await pauseContinuous(B);
    if (!(await reviewVisible(B))) await triggerPull(B);
    let review;
    try {
      review = await waitReview(B);
    } catch (error) {
      const diagnostic = await evaluate(B, `(()=>{const e=app.plugins.plugins.sink.getSyncEngine(); return {modals:document.querySelectorAll('.modal-container').length,reviewModal:!!document.querySelector('.sink-review-modal'),fileList:!!document.querySelector('.sink-review-file-list'),bodyText:document.body.innerText.slice(-800),startupInProgress:e?.startupInProgress,reviewStatusActive:e?.reviewStatusActive,reviewCancelled:e?.reviewCancelled,status:e?.getStatus?.(),head:e?.getSyncHeadState?.(),pending:e?[...e.pendingIncoming]:[],errors:(window.__sinkE2EErrors||[]).slice(-5)}})()`);
      throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
    }
    assert.equal(review.count, 3, `conflict review counted ${review.count}`);
    const state = await evaluate(B, `(()=>{const rows=[...document.querySelectorAll('.sink-review-file-row')]; return {rows:rows.length, paths:rows.map(row=>row.querySelector('.sink-review-file-path')?.textContent||''), blocked:rows.map(row=>(row.querySelector('.sink-review-file-meta')?.textContent||'').includes('Blocked:')), selectors:document.querySelectorAll('.sink-review-revision-select').length, applyDisabled:document.querySelector('.sink-review-apply')?.disabled===true}})()`);
    assert.equal(state.rows, 3, `conflict rows were ${state.rows}`);
    assert.equal(state.blocked.every(Boolean), false, "conflict rows were still marked blocked");
    assert.equal(state.selectors, 0, "diff opened by default");
    assert.equal(state.applyDisabled, false, "apply was disabled for resolvable conflicts");
    await evaluate(B, "(()=>{document.querySelector('.sink-review-file-row .sink-review-file-meta').click(); return true})()");
    try {
      await until("conflict revision selector", () => evaluate(B, "!!document.querySelector('.sink-review-revision-select')"), 15000, 150);
    } catch (error) {
      const diagnostic = await evaluate(B, "(()=>({rows:[...document.querySelectorAll('.sink-review-file-row')].map(row=>({meta:row.querySelector('.sink-review-file-meta')?.textContent||'',active:row.classList.contains('is-active')})),preview:document.querySelector('.sink-review-preview-content')?.textContent||'',selectors:document.querySelectorAll('.sink-review-revision-select').length}))()");
      throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
    }

    const bulk = await evaluate(B, `(()=>{const select=document.querySelector('.sink-review-bulk-select'); if(!select) return false; select.value='keep-remote'; select.dispatchEvent(new Event('change',{bubbles:true})); return true})()`);
    assert.equal(bulk, true, "bulk keep-remote control was missing");
    const chosen = await chooseConflictRevision(B, paths[0], selectedRev);
    assert.equal(chosen.selected, selectedRev, `could not select non-winning revision: ${JSON.stringify(chosen)}`);
    assert.equal(await clickIn(B, ".sink-review-modal", "Apply selected"), true, "apply failed");
    await until("conflict review applied", async () => !(await reviewVisible(B)), 30000, 150);
    await approveIfAsked(B);
    await resumeContinuous(B);

    const expected = new Map();
    expected.set(paths[0], selectedLeaf.content);
    for (const rel of paths.slice(1)) expected.set(rel, before.get(rel).content);
    await until("CouchDB conflict retirement", async () => {
      for (const rel of paths) {
        const doc = await remoteDoc(couch, `file:${rel}`, true);
        if (!doc || doc._deleted || doc._conflicts?.length) return false;
      }
      return true;
    }, 40000, 250);
    for (const rel of paths) {
      const doc = await remoteDoc(couch, `file:${rel}`, true);
      assert.equal(doc._conflicts, undefined, `remote conflict leaves remained for ${rel}`);
      assert.notEqual(doc._rev, before.get(rel)._rev, `remote winner did not change for ${rel}`);
      await until(`local conflict file ${rel}`, () => existsSync(path.join(B.vault, rel)), 20000, 200);
      assert.equal(await readRel(B, rel), expected.get(rel), `local conflict content mismatch for ${rel}`);
    }
    await resumeContinuous(B);
    return { conflictedBranches: 3, selectedNonWinning: selectedRev, conflictsResolved: true, contentMatched: true };
  });

  console.log(`\nEvidence: ${path.join(ARTIFACTS, "evidence.json")}`);
  console.log(`Screenshots: ${screenshots.length ? screenshots.map((shot) => shot.file).join(", ") : "none"}`);
  const passed = results.filter((entry) => entry.status === "pass").length;
  const failed = results.length - passed;
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  await fs.writeFile(path.join(ARTIFACTS, "evidence.json"), JSON.stringify({
    run: RUN, version, startedAt: new Date().toISOString(), artifacts: ARTIFACTS,
    passed, failed, results,
  }, null, 2));
  if (failed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`SETUP BLOCKER: ${redact(error)}`);
  await fs.mkdir(ARTIFACTS, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(ARTIFACTS, "evidence.json"), JSON.stringify({
    run: RUN, artifacts: ARTIFACTS, passed: 0, failed: 1,
    results: [{ name: "setup", status: "fail", error: redact(error) }],
  }, null, 2)).catch(() => {});
  process.exitCode = 1;
} finally {
  await cleanup();
}
