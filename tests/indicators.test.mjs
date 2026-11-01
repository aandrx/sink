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

test("status bar does not equate a transport connection with completed application", () => {
  const { StatusBar } = load("StatusBar");
  const el = element();
  new StatusBar(el).setStatus("connected");
  assert.match(el.tooltip, /pending reviews/);
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
  assert.equal(label.text, "Empty");
  floating.destroy();
});
