import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const seriesPattern = /^2\.([2-9]|[1-9][0-9]+)(?![\s\S])/;
const versionPattern = /^(2\.(?:[2-9]|[1-9][0-9]+))\.(?:0|[1-9][0-9]*)(?![\s\S])/;
const workflowPattern = /^opencode-(2\.(?:[2-9]|[1-9][0-9]+)(?:\.(?:0|[1-9][0-9]*))?)\.yml(?![\s\S])/;

function compareVersions(a, b) {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 1; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i].length - y[i].length || (x[i] < y[i] ? -1 : 1);
  }
  return x.length - y.length;
}

export function workflowTargets(names) {
  return names.flatMap((name) => {
    const match = workflowPattern.exec(name);
    return match ? [match[1]] : [];
  }).sort(compareVersions);
}

export function resolveVersions(json, targets) {
  if (!targets.length) throw new Error("No OpenCode version workflows found");
  const parsed = JSON.parse(json);
  const versions = typeof parsed === "string" ? [parsed] : parsed;
  if (!Array.isArray(versions)) throw new Error("Expected a version string or array");

  const latest = new Map();
  const stable = new Set();
  for (const version of versions) {
    const match = typeof version === "string" && versionPattern.exec(version);
    if (!match) continue;
    stable.add(version);
    const [, item] = match;
    const previous = latest.get(item);
    if (!previous || compareVersions(version, previous) > 0) {
      latest.set(item, version);
    }
  }

  return targets.map((item) => {
    if (versionPattern.test(item)) {
      if (!stable.has(item)) throw new Error(`OpenCode release ${item} not found in catalog`);
      return item;
    }
    const release = latest.get(item);
    if (!release) throw new Error(`No stable OpenCode release for ${item}`);
    return release;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) throw new Error("Expected at most one OpenCode series");
    if (args.length && !seriesPattern.test(args[0])) {
      throw new Error(`Invalid OpenCode series: ${args[0]}`);
    }
    const targets = args.length ? args : workflowTargets(
      readdirSync(new URL("../.github/workflows/", import.meta.url), { withFileTypes: true })
        .filter((entry) => entry.isFile()).map((entry) => entry.name),
    );
    const versions = resolveVersions(readFileSync(0, "utf8"), targets);
    process.stdout.write(`${versions.join("\n")}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
