import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { release } from '../scripts/release.mjs';

const script = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));
const repo = 'example/oc-router';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'oc-router-release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  const commit = (version, notes) => {
    writeFileSync(join(cwd, 'package.json'), `${JSON.stringify({ version })}\n`);
    if (notes !== undefined) writeFileSync(join(cwd, 'RELEASE_NOTES.md'), notes);
    git('add', 'package.json', ...(notes === undefined ? [] : ['RELEASE_NOTES.md']));
    git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.org',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { cwd, commit, preview: () => readFileSync(join(cwd, 'release-preview.md'), 'utf8') };
}

function pr(number, merge_commit_sha, title = `PR ${number}`, branch = 'beta') {
  return { number, merge_commit_sha, title, merged_at: '2026-11-27T00:00:00Z', base: { ref: branch } };
}

test('beta CLI lists all and only eligible PRs, sorted and deduplicated, with inert titles', t => {
  const { cwd, commit, preview } = fixture(t);
  const integrated = commit('1.0.0');
  const base = commit('1.0.0');
  const first = commit('1.0.0');
  const head = commit('1.1.0');
  const later = commit('1.2.0');
  const input = JSON.stringify([
    pr(9, head), pr(1, integrated), pr(12, later), pr(3, first, '[x](https://bad.example)\n# <img>@all\u202e'),
    pr(9, head), pr(5, first, 'Wrong branch', 'main'), { ...pr(6, head), merged_at: null },
  ]);
  assert.equal(execFileSync(process.execPath, [script, 'preview', base, head, 'beta', '30', repo],
    { cwd, input, encoding: 'utf8' }), 'v1.1.0\n');
  assert.equal(preview(), '# OC Router v1.1.0\n\n<!-- Release PR #30 (beta) -->\n\n## Pull requests\n' +
    '- [#3](https://github.com/example/oc-router/pull/3) &#91;x&#93;&#40;https&#58;&#47;&#47;bad&#46;example&#41; &#35; &#60;img&#62;&#64;all\n' +
    '- [#9](https://github.com/example/oc-router/pull/9) PR 9\n');
  assert.throws(() => release(['preview', base, head, 'beta', '30', repo], {
    cwd, readInput: () => JSON.stringify([pr(2, 'a'.repeat(40))]),
  }), /git merge-base failed/);
  release(['preview', base, head, 'beta', '30', repo], { cwd, readInput: () => '[]' });
  assert.equal(preview(), '# OC Router v1.1.0\n\n<!-- Release PR #30 (beta) -->\n\n## Pull requests\n');
});

test('fix ignores beta input and verify copies versioned notes unchanged', t => {
  const { cwd, commit, preview } = fixture(t);
  const base = commit('1.0.0');
  const notes = '# OC Router v1.0.1\n\n<!-- Release PR #42 (fix) -->\n\n## Pull requests\n- [#42](https://github.com/example/oc-router/pull/42) Fix &#42;now&#42;\n';
  const head = commit('1.0.1', notes);
  assert.equal(release(['preview', base, head, 'fix', '42', repo], {
    cwd, env: { RELEASE_PR_TITLE: 'Fix *now*' }, readInput: () => assert.fail('fix must not read stdin'),
  }), 'v1.0.1');
  assert.equal(preview(), notes);
  writeFileSync(join(cwd, 'RELEASE_NOTES.md'), 'uncommitted');
  assert.equal(execFileSync(process.execPath, [script, 'verify', base, head, 'fix', '42', repo],
    { cwd, encoding: 'utf8' }), 'v1.0.1\n');
  assert.equal(preview(), notes);
  const wrong = commit('1.0.2', '## Wrong heading\n\n# OC Router v1.0.2\n');
  assert.throws(() => release(['verify', base, wrong, 'fix', '42', repo], { cwd }), /promotion PR/);
  assert.throws(() => release(['verify', base, head, 'fix', '43', repo], { cwd }), /promotion PR/);
  assert.throws(() => release(['verify', base, head, 'beta', '42', repo], { cwd }), /promotion PR/);
});

test('invalid, equal and decreasing versions fail without printing a tag', t => {
  const { cwd, commit } = fixture(t);
  const base = commit('2.0.0');
  const invalid = commit('2.0.1-beta.1');
  const lower = commit('1.99.99');
  for (const head of [invalid, base, lower]) {
    const result = spawnSync(process.execPath, [script, 'verify', base, head, 'beta', '42', repo], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /version/);
  }
});
