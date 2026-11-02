import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

function load(file) {
  const module = { exports: {} };
  const { code } = transformSync(readFileSync(new URL(`../src/ui/${file}.ts`, import.meta.url), "utf8"), { loader: "ts", format: "cjs" });
  new Function("module", "exports", "require", code)(module, module.exports, () => ({ setTooltip: (el, text) => { el.tooltip = text; } }));
  return module.exports;
}
function element() {
  return { text: "", classes: new Set(), children: [], attributes: {},
    addClass(...classes) { classes.forEach((c) => this.classes.add(c)); },
    removeClass(...classes) { classes.forEach((c) => this.classes.delete(c)); },
    setText(text) { this.text = text; },
    setAttribute(name, value) { this.attributes[name] = value; },
    createDiv() { const child = element(); this.children.push(child); return child; },
    remove() {},
  };
}

test("ribbon identifies a review pause without claiming disconnection or HEAD", () => {
  const { RibbonIcon } = load("StatusBar");
  const el = element();
  const ribbon = new RibbonIcon(el);
  ribbon.update("paused", "secondary", "behind");
  assert.match(el.attributes["aria-label"], /Waiting for review/);
  assert.ok(el.classes.has("sink-ribbon-paused"));
  assert.ok(!el.classes.has("sink-ribbon-syncing"));
  assert.doesNotMatch(el.attributes["aria-label"], /Disconnected/);
  ribbon.update("connected", "secondary", "behind");
  assert.match(el.attributes["aria-label"], /Pending remote changes/);
  ribbon.update("connected", "secondary", "head");
  assert.doesNotMatch(el.attributes["aria-label"], /At HEAD/);
});

test("status bar shows a connected check and never claims pending reviews", () => {
  const { StatusBar } = load("StatusBar");
  const el = element();
  new StatusBar(el).setStatus("connected");
  assert.match(el.text, /✓/);
  assert.equal(el.tooltip, "Sink: Connected to server");
});

test("status bar distinguishes paused from disconnected", () => {
  const { StatusBar } = load("StatusBar");
  const el = element();
  const statusBar = new StatusBar(el);
  statusBar.setStatus("paused");
  assert.match(el.tooltip, /Waiting for review or permission/);
  statusBar.setStatus("disconnected");
  assert.match(el.tooltip, /Not connected to server/);
});

test("floating overlay uses plain status words", () => {
  const { FloatingStatus } = load("FloatingStatus");
  const root = element();
  const floating = new FloatingStatus(root);
  const label = root.children[0].children[0];
  const expected = {
    connected: "Connected",
    syncing: "Syncing",
    paused: "Review",
    error: "Blocked",
    disconnected: "Disconnected",
  };
  for (const [status, word] of Object.entries(expected)) {
    floating.setStatus(status);
    assert.equal(label.text, word, `status ${status}`);
  }
  floating.destroy();
});

test("floating overlay is decorative and hidden from assistive tech", () => {
  const { FloatingStatus } = load("FloatingStatus");
  const root = element();
  const floating = new FloatingStatus(root);
  assert.equal(root.children[0].attributes["aria-hidden"], "true");
  floating.destroy();
});

test("floating activity reads as sending or receiving with source detail", () => {
  const { FloatingStatus } = load("FloatingStatus");
  const root = element();
  const floating = new FloatingStatus(root);
  const label = root.children[0].children[0];
  const detail = root.children[0].children[1];

  floating.showActivity("notes/example.md", "pull", "laptop");
  assert.equal(label.text, "Receiving example.md");
  assert.equal(detail.text, "From laptop");

  floating.showActivity("notes/example.md", "push");
  assert.equal(label.text, "Sending example.md");
  assert.equal(detail.text, "");
  floating.destroy();
});

test("paused gets a warning class of its own, not the disconnected grey", () => {
  const { FloatingStatus } = load("FloatingStatus");
  const root = element();
  const floating = new FloatingStatus(root);
  const label = root.children[0].children[0];
  floating.setStatus("paused");
  assert.ok(label.classes.has("sink-floating-paused"));
  assert.ok(!label.classes.has("sink-floating-disconnected"));
  floating.setStatus("disconnected");
  assert.ok(label.classes.has("sink-floating-disconnected"));
  assert.ok(!label.classes.has("sink-floating-paused"));
  floating.destroy();
});

test("blocked and disconnected states interrupt stale floating file activity", () => {
  const { FloatingStatus } = load("FloatingStatus");
  const root = element();
  const floating = new FloatingStatus(root);
  const label = root.children[0].children[0];
  floating.showActivity("example.md", "pull");
  floating.setStatus("error");
  assert.equal(label.text, "Blocked");
  floating.showActivity("example.md", "push");
  floating.setStatus("disconnected");
  assert.equal(label.text, "Disconnected");
  floating.destroy();
});
