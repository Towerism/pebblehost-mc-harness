// bin/check gate, postmortem and runbook end to end in a temp project: the
// bare-text loop with real git, and the e2e confirm run against a fake docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readRecords } from '../../src/check/record.ts';
import { check, commit, E2E, git, LABELS, project, write } from './project.ts';

test('bare-text red, fix, green, gate with its confirm run, then postmortem and runbook; each refused before its turn', () => {
  const root = project({ 'server/old.yml': 'x: 1\n' });
  git(root, 'branch', 'main');
  commit(root, { 'checks/3-crate/profile.json': '{"kind":"bare-text"}\n', 'checks/3-crate/crate.test.ts': "import { test, bareText } from '#harness/unit';\ntest('crate name', () => bareText('config.yml', 'crate.name', 'Vote Crate!'));\n" });
  const redCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  assert.equal(check(root, {}, 'run', '3-crate').status, 1);
  let r = check(root, {}, 'postmortem', '3-crate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the gate refuses 3-crate:\n {2}G1: no passing run of 3-crate/);
  git(root, 'rm', '-q', 'server/old.yml');
  commit(root, { 'server/config.yml': "crate:\n  name: 'Vote Crate!'\n" });
  assert.equal(check(root, {}, 'run', '3-crate').status, 0);
  r = check(root, {}, 'gate', '3-crate', '--no-confirm');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /passed, not confirmed/);
  r = check(root, {}, 'runbook', '3-crate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the green of 3-crate is not confirmed; run bin\/check gate 3-crate/);
  r = check(root, {}, 'gate', '3-crate');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gate: 3-crate passed and confirmed/);
  assert.deepEqual(readRecords(root, 3).map((x) => [x.pass, x.confirm]), [[false, false], [true, false], [true, true]]);
  r = check(root, {}, 'postmortem', '3-crate');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /docs\/postmortems\/\d{4}-\d\d-\d\d-3-crate\.md/);
  const pm = readFileSync(r.stdout.trim().replace(/^postmortem: wrote /, ''), 'utf8');
  for (const part of ['# Postmortem: crate (issue 3)', '## Cause', '## Wrong turns', `failed on commit \`${redCommit}\``, '"pass": false', '"confirm": true', 'config.yml', 'Vote Crate!']) assert.ok(pm.includes(part), part);
  assert.ok(!pm.includes('{{'), 'unfilled template field');
  r = check(root, {}, 'postmortem', '3-crate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /exists; edit it instead/);
  r = check(root, {}, 'runbook', '3-crate');
  assert.equal(r.status, 0, r.stderr);
  const rb = readFileSync(r.stdout.trim().replace(/^runbook: wrote /, ''), 'utf8');
  for (const part of ['bin/dev sync', '   - `config.yml`', '   - `old.yml` (deleted', 'bin/check runbook push 3', 'bin/check run 3-crate --target live --issue 3']) assert.ok(rb.includes(part), part);
  assert.ok(rb.indexOf('bin/dev sync') < rb.indexOf('runbook push') && rb.indexOf('runbook push') < rb.indexOf('--target live'));
});

test('the e2e confirm run needs the green image running; the gate never boots one', () => {
  const root = project({
    ...E2E,
    'checks/3-motd/motd.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dev } from '#harness/dev';\ntest('normal', async () => assert.match(await dev.console('difficulty'), /Normal/));\n",
  });
  const rev = (r: string) => git(root, 'rev-parse', r).stdout.trim();
  const a = rev('HEAD');
  commit(root, { 'server/config.yml': "crate:\n  name: 'Fixed'\n" });
  const b = rev('HEAD');
  const ident = (c: string) => ({ commit: c, treeHash: rev(`${c}:server`), harnessHash: 'h1', imageHash: createHash('sha256').update(`${rev(`${c}:server`)}\nh1`).digest('hex') });
  const base = { check: '3-motd', issue: 3, kind: 'e2e', target: 'dev', time: 't', source: 'archive', fixturesHash: 'f1', checkHash: rev('HEAD:checks/3-motd'), containerId: 'c', confirm: false, output: '' };
  write(root, { '.verify/runs/issue-3.jsonl': `${JSON.stringify({ ...base, ...ident(a), pass: false, generation: 'g1', fresh: true, explored: false })}\n${JSON.stringify({ ...base, ...ident(b), pass: true, generation: 'g2', fresh: false, explored: false })}\n` });
  const green = ident(b);
  let r = check(root, { FAKE_LABELS: JSON.stringify({ ...LABELS, 'mc-harness.image': ident(a).imageHash }) }, 'gate', '3-motd');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no running pod dev booted from the green's image [0-9a-f]{12}; run bin\/dev rebuild first/);
  const labels = { ...LABELS, 'mc-harness.commit': b, 'mc-harness.tree': green.treeHash, 'mc-harness.image': green.imageHash };
  r = check(root, { FAKE_LABELS: JSON.stringify(labels), FAKE_REPLY: '{"ok":true,"reply":"The difficulty is Easy"}' }, 'gate', '3-motd');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the confirm run of 3-motd failed/);
  r = check(root, { FAKE_LABELS: JSON.stringify(labels), FAKE_REPLY: '{"ok":true,"reply":"The difficulty is Normal"}' }, 'gate', '3-motd');
  assert.equal(r.status, 0, r.stderr);
  const last = readRecords(root, 3).at(-1);
  assert.deepEqual([last?.confirm, last?.pass, last?.imageHash], [true, true, green.imageHash]);
});
