// bin/check gate's e2e confirm run against a fake docker: the green's image,
// an unexplored volume and the green's fixtures, never a pod it boots itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRecords } from '../../src/check/record.ts';
import { check, commit, E2E, git, LABELS, project, write } from './project.ts';

const records = (root: string) => {
  git(root, 'add', '.verify');
  git(root, 'commit', '-q', '-m', 'records');
};

test('the e2e confirm run needs the green image running on an unexplored volume with the green fixtures; the gate never boots one', () => {
  const root = project({
    ...E2E,
    'checks/3-motd/motd.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dev } from '#harness/dev';\ntest('normal', async () => assert.match(await dev.console('difficulty'), /Normal/));\n",
  });
  const rev = (r: string) => git(root, 'rev-parse', r).stdout.trim();
  const a = rev('HEAD');
  commit(root, { 'server/config.yml': "crate:\n  name: 'Fixed'\n" });
  const b = rev('HEAD');
  const ident = (c: string) => ({ commit: c, treeHash: rev(`${c}:server`), harnessHash: 'h1', imageHash: createHash('sha256').update(`${rev(`${c}:server`)}\nh1`).digest('hex') });
  const base = { check: '3-motd', issue: 3, kind: 'e2e', target: 'dev', source: 'archive', fixturesHash: 'f1', checkHash: rev('HEAD:checks/3-motd'), containerId: 'c', runIndex: 0, toolHash: 'tool1', confirm: false, output: '' };
  write(root, { '.verify/runs/issue-3.jsonl': `${JSON.stringify({ ...base, ...ident(a), time: '2026-01-01T00:00:01Z', pass: false, generation: 'g1', fresh: true, explored: false })}\n${JSON.stringify({ ...base, ...ident(b), time: '2026-01-01T00:00:02Z', pass: true, generation: 'g2', fresh: false, explored: false })}\n` });
  records(root);
  const green = ident(b);
  let r = check(root, { FAKE_LABELS: JSON.stringify({ ...LABELS, 'mc-harness.image': ident(a).imageHash }) }, 'gate', '3-motd');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no running pod dev booted from the green's image [0-9a-f]{12}; run bin\/dev rebuild first/);
  const labels = { ...LABELS, 'mc-harness.commit': b, 'mc-harness.tree': green.treeHash, 'mc-harness.image': green.imageHash };
  const normal = '{"ok":true,"reply":"The difficulty is Normal"}';
  write(root, { 'fakefs/.mc-harness-explored': '' });
  r = check(root, { FAKE_LABELS: JSON.stringify(labels), FAKE_REPLY: normal }, 'gate', '3-motd');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pod dev's volume was explored \(bin\/dev console or join\); run bin\/dev rebuild first/);
  git(root, 'clean', '-qfx', 'fakefs');
  r = check(root, { FAKE_LABELS: JSON.stringify(labels), FAKE_REPLY: '{"ok":true,"reply":"The difficulty is Easy"}' }, 'gate', '3-motd');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the confirm run of 3-motd failed/);
  r = check(root, { FAKE_LABELS: JSON.stringify({ ...labels, 'mc-harness.fixtures': 'f2' }), FAKE_REPLY: normal }, 'gate', '3-motd');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the confirm run of 3-motd does not match the green/);
  // Those failed confirms were runs on this volume: a confirm after them is
  // not the next run after the green. A rebuilt pod (a new volume) is.
  r = check(root, { FAKE_LABELS: JSON.stringify(labels), FAKE_REPLY: normal }, 'gate', '3-motd');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the confirm run of 3-motd does not match the green/);
  git(root, 'clean', '-qfx', 'fakefs');
  r = check(root, { FAKE_LABELS: JSON.stringify({ ...labels, 'mc-harness.generation': 'gen-new' }), FAKE_REPLY: normal }, 'gate', '3-motd');
  assert.equal(r.status, 0, r.stderr);
  const last = readRecords(root, 3).at(-1);
  assert.deepEqual([last?.confirm, last?.pass, last?.imageHash, last?.explored, last?.runIndex], [true, true, green.imageHash, false, 0]);
});
