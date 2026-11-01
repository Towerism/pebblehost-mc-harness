// bin/check gate, postmortem and runbook end to end in a temp project: the
// bare-text loop with real git, G10 on real files, and the confirm rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRecords } from '../../src/check/record.ts';
import { check, commit, git, project } from './project.ts';

const records = (root: string) => {
  git(root, 'add', '.verify');
  git(root, 'commit', '-q', '-m', 'records');
};

test('bare-text red, fix, green, committed records, gate with its confirm run, then postmortem and runbook; each refused before its turn', () => {
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
  assert.equal(r.status, 2);
  // The red's line went in with the fix commit; the green's is not committed yet.
  assert.match(r.stderr, /G10: the green record is not committed as is in \.verify\/runs\/issue-3\.jsonl/);
  records(root);
  r = check(root, {}, 'gate', '3-crate', '--no-confirm');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /passed, not confirmed/);
  r = check(root, {}, 'runbook', '3-crate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the green of 3-crate is not confirmed \(no confirm run on the green's image\); run bin\/dev rebuild, then bin\/check gate 3-crate/);
  r = check(root, {}, 'gate', '3-crate');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gate: 3-crate passed and confirmed; the confirm run is recorded in .*: commit it/);
  assert.deepEqual(readRecords(root, 3).map((x) => [x.pass, x.confirm]), [[false, false], [true, false], [true, true]]);
  // The confirm record must be committed too before any doc is written.
  r = check(root, {}, 'postmortem', '3-crate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the confirm record of 3-crate is not committed as is in \.verify\/runs\/issue-3\.jsonl; commit it first \(G10\)/);
  records(root);
  r = check(root, {}, 'postmortem', '3-crate');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /docs\/postmortems\/\d{4}-\d\d-\d\d-3-crate\.md/);
  const pm = readFileSync(r.stdout.trim().replace(/^postmortem: wrote /, ''), 'utf8');
  for (const part of ['# Postmortem: crate (issue 3)', '## Cause', '## Fix diff review', "+  name: 'Vote Crate!'", 'Commit `.verify/runs/issue-3.jsonl`', '## Wrong turns', `failed on commit \`${redCommit}\``, '"pass": false', '"confirm": true']) assert.ok(pm.includes(part), part);
  assert.ok(!pm.includes('{{'), 'unfilled template field');
  r = check(root, {}, 'postmortem', '3-crate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /exists; edit it instead/);
  r = check(root, {}, 'runbook', '3-crate');
  assert.equal(r.status, 0, r.stderr);
  const rb = readFileSync(r.stdout.trim().replace(/^runbook: wrote /, ''), 'utf8');
  for (const part of ['bin/dev sync', '   - `config.yml`', '   - `old.yml` (deleted', 'bin/check runbook push 3', 'bin/check run 3-crate --target live --issue 3']) assert.ok(rb.includes(part), part);
  assert.ok(rb.indexOf('bin/dev sync') < rb.indexOf('runbook push') && rb.indexOf('runbook push') < rb.indexOf('--target live'));
  // A server change committed after the green never ran: gate and docs refuse.
  commit(root, { 'server/untested.yml': 'x: 1\n' });
  for (const cmd of ['gate', 'postmortem', 'runbook']) {
    r = check(root, {}, cmd, '3-crate');
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /G7: server\/ changed after the green, untested: untested\.yml/, cmd);
  }
});
