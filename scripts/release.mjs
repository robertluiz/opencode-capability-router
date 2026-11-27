import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(cwd, args, ancestorCheck = false) {
  const result = spawnSync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (ancestorCheck && result.status === 1) return false;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return ancestorCheck ? true : result.stdout;
}

function sha(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)) {
    throw new Error('Expected a full Git SHA');
  }
  return value;
}

function prNumber(value) {
  if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Invalid PR number');
  }
  return Number(value);
}

function version(cwd, commit) {
  const value = JSON.parse(git(cwd, ['show', `${commit}:package.json`])).version;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error('Expected a numeric major.minor.patch version');
  }
  return value;
}

function escapeTitle(title) {
  if (typeof title !== 'string') throw new Error('Invalid PR title');
  return title.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim()
    .replace(/[!-/:-@[-`{-~]/g, char => `&#${char.charCodeAt(0)};`);
}

function betaPulls(cwd, base, head, pulls) {
  if (!Array.isArray(pulls)) throw new Error('Expected a flat JSON array of PRs');
  const eligible = new Map();
  for (const pr of pulls) {
    if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw new Error('Invalid PR record');
    if (!pr.merged_at || (pr.base?.ref !== undefined && pr.base.ref !== 'beta')) continue;
    const commit = sha(pr.merge_commit_sha);
    if (!git(cwd, ['merge-base', '--is-ancestor', commit, head], true) ||
        git(cwd, ['merge-base', '--is-ancestor', commit, base], true)) continue;
    const number = prNumber(pr.number);
    if (!eligible.has(number)) eligible.set(number, pr.title);
  }
  return [...eligible].sort(([a], [b]) => a - b);
}

export function release(argv, { cwd = process.cwd(), env = process.env, readInput = () => readFileSync(0, 'utf8') } = {}) {
  const [command, base, head, kind, number, repo] = argv;
  if (!['preview', 'verify'].includes(command) || argv.length !== 6) {
    throw new Error('Usage: preview|verify BASE_SHA HEAD_SHA beta|fix NUMBER REPO');
  }
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repo) || /\/\.{1,2}$/.test(repo)) {
    throw new Error('Invalid GitHub repository slug');
  }
  const before = version(cwd, sha(base)).split('.').map(BigInt);
  const after = version(cwd, sha(head));
  const difference = after.split('.').map((value, i) => BigInt(value) - before[i]).find(value => value !== 0n);
  if (difference === undefined || difference < 0n) throw new Error('Release version must increase');

  const tag = `v${after}`;
  const promotion = prNumber(number);
  if (kind !== 'beta' && kind !== 'fix') throw new Error('Expected beta or fix');
  const heading = `# OC Router ${tag}\n\n<!-- Release PR #${promotion} (${kind}) -->\n`;
  let notes;
  if (command === 'preview') {
    const pulls = kind === 'beta'
      ? betaPulls(cwd, base, head, JSON.parse(readInput()))
      : [[promotion, env.RELEASE_PR_TITLE ?? '']];
    const items = pulls.map(([id, title]) => {
      const label = escapeTitle(title);
      return `- [#${id}](https://github.com/${repo}/pull/${id})${label ? ` ${label}` : ''}`;
    });
    notes = [heading, '## Pull requests', ...items, ''].join('\n');
  } else {
    notes = git(cwd, ['show', `${head}:RELEASE_NOTES.md`]);
    if (!notes.toString('utf8').startsWith(heading)) throw new Error('Release notes do not match the version and promotion PR');
  }
  writeFileSync(resolve(cwd, 'release-preview.md'), notes);
  return tag;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${release(process.argv.slice(2))}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
