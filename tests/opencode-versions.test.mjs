import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = new URL("../eval/resolve-opencode-versions.mjs", import.meta.url);
const run = (path, input, ...args) =>
  spawnSync(process.execPath, [path, ...args], { input, encoding: "utf8" });

function assertFailure(result, message) {
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, message);
}

test("selects the greatest canonical stable patch numerically", () => {
  const result = run(fileURLToPath(script), JSON.stringify([
    "2.3.10", "2.3.9", "2.3.11-preview", "2.3.99+build", "2.3.099",
    "2.03.99", "02.3.99", "2.3.99\n", "2.3.99!", "2.30.99", null,
  ]), "2.3");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "2.3.10\n");
});

test("accepts a single JSON string and rejects invalid requests without output", () => {
  const path = fileURLToPath(script);
  assert.equal(run(path, '"2.2.0"', "2.2").stdout, "2.2.0\n");
  assertFailure(run(path, '["2.2.0"]', "2.02"), /Invalid OpenCode series/);
  assertFailure(run(path, '["2.2.0"]', "2.2.0"), /Invalid OpenCode series/);
  assertFailure(run(path, '["2.3.0-rc.1"]', "2.3"), /No stable OpenCode release/);
  assertFailure(run(path, '["2.3.0",', "2.3"), /JSON/);
  assertFailure(run(path, '{"version":"2.3.0"}', "2.3"), /Expected a version/);
});

test("discovers pinned and moving targets by filename and resolves them atomically", (t) => {
  const root = mkdtempSync(join(tmpdir(), "opencode-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  mkdirSync(join(root, "eval"));
  const path = join(root, "eval", "resolve-opencode-versions.mjs");
  copyFileSync(script, path);
  for (const name of ["opencode-regression.yml", "opencode-2.04.yml", "opencode-2.3.01.yml"]) {
    writeFileSync(join(workflows, name), "");
  }
  assertFailure(run(path, "[]"), /No OpenCode version workflows/);

  for (const name of ["opencode-2.2.0.yml", "opencode-2.3.yml", "opencode-2.4.yml", "opencode-2.10.yml"]) {
    writeFileSync(join(workflows, name), "not YAML, only the name matters");
  }
  const catalog = ["2.10.1", "2.3.2", "2.4.2", "2.2.0", "2.2.99"];
  const result = run(path, JSON.stringify(catalog));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "2.2.0\n2.3.2\n2.4.2\n2.10.1\n");
  assertFailure(run(path, JSON.stringify(catalog.filter((v) => v !== "2.2.0"))), /2\.2\.0 not found/);
  assertFailure(run(path, JSON.stringify(catalog.slice(1))), /No stable OpenCode release for 2\.10/);
});
