import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
test("0.2.20 release metadata agrees and requires an unprefixed tag", () => {
  const pkg = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("manifest.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.version, "0.2.20");
  for (const version of [manifest.version, lock.version, lock.packages[""].version]) assert.equal(version, pkg.version);
  const workflow = read(".github/workflows/release.yml");
  assert.doesNotMatch(workflow, /v\[0-9\]/);
  assert.doesNotMatch(workflow, /replace\(\/\^v/);
  assert.match(workflow, /Use an unprefixed release tag/);
  assert.ok(existsSync(new URL(`../docs/releases/${pkg.version}.md`, import.meta.url)));
});
