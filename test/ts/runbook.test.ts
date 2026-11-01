// Unit tests for bin/check runbook push (src/sync/runbookPush.ts) without
// SFTP: the push set of main...issue/N, drift on main since the cut, and the
// CLI refusals that come before any transfer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainDrift, pushSet } from '../../src/sync/runbookPush.ts';
import { check, commit, git, tmp } from './project.ts';

// main with a server tree, then issue/9 cut from it.
function repo(): string {
  const root = tmp();
  git(root, 'init', '-q', '-b', 'main');
  commit(root, { '.gitignore': '.dev/\n', 'server/config.yml': 'a: 1\n', 'server/old.yml': 'x\n', 'server/plugins/Eco/config.yml': 'rate: 1\n', 'docs/a.md': 'a\n' });
  git(root, 'switch', '-q', '-c', 'issue/9');
  return root;
}

test('the push set is the server/ paths of main...issue/N, prefix stripped; other paths are not pushed, deletes are manual', () => {
  const root = repo();
  commit(root, { 'server/config.yml': 'a: 2\n', 'server/plugins/Eco/lang/en.yml': 'hi: x\n', 'server/a b.yml': 'q\n', 'checks/9-x/profile.json': '{"kind":"e2e"}\n', 'docs/a.md': 'b\n' });
  git(root, 'rm', '-q', 'server/old.yml');
  git(root, 'commit', '-q', '-m', 'rm');
  // A later main commit outside the issue's paths changes nothing here.
  git(root, 'switch', '-q', 'main');
  commit(root, { 'server/other.yml': 'o\n' });
  assert.deepEqual(pushSet(root, 9), { changed: ['config.yml'], added: ['a b.yml', 'plugins/Eco/lang/en.yml'], deleted: ['old.yml'], notPushed: ['checks/9-x/profile.json', 'docs/a.md'] });
  assert.deepEqual(mainDrift(root, 9, ['config.yml', 'a b.yml', 'plugins/Eco/lang/en.yml']), []);
});

test('drift is a main change since the cut to a path of the set, matched literally', () => {
  const root = repo();
  commit(root, { 'server/config.yml': 'a: 2\n', 'server/plugins/Eco/config.yml': 'rate: 2\n' });
  git(root, 'switch', '-q', 'main');
  commit(root, { 'server/config.yml': 'a: live\n', 'server/plugins/*/x.yml': 'glob-looking\n' });
  assert.deepEqual(mainDrift(root, 9, ['config.yml', 'plugins/Eco/config.yml']), ['config.yml']);
  assert.deepEqual(mainDrift(root, 9, ['plugins/Eco/config.yml']), []);
  assert.deepEqual(mainDrift(root, 9, []), []);
});

test('runbook push and rollback refuse before any transfer: no number, no branch, a sync-rules path, no runbook, no gate pass, drift, no journal', () => {
  const root = repo();
  commit(root, { 'server/config.yml': 'a: 2\n', 'server/plugins/Eco/data.db': 'db' });
  const run = (...args: string[]) => check(root, {}, 'runbook', ...args);
  let r = run('push');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /runbook push needs an issue number/);
  r = run('push', '4');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no issue\/4 branch/);
  r = run('push', '9', '--plan');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /sync-rules data \*\.db covers server\/plugins\/Eco\/data\.db; it is never pushed/);
  git(root, 'rm', '-q', 'server/plugins/Eco/data.db');
  git(root, 'commit', '-q', '-m', 'no db');
  r = run('push', '9');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /issue\/9 has no committed docs\/runbooks\/<date>-9-<slug>\.md/);
  commit(root, { 'docs/runbooks/2026-11-01-9-x.md': 'r\n' });
  r = run('push', '9');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /runbook push 9: issue\/9 has no committed checks\/9-\*; a push needs a gate pass/);
  commit(root, { 'checks/9-x/profile.json': '{"kind":"bare-text"}\n', 'checks/9-x/a.test.ts': "import { test, bareText } from '#harness/unit';\ntest('a', () => bareText('config.yml', 'a', '2'));\n" });
  r = run('push', '9');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /runbook push 9: the gate refuses 9-x:/);
  git(root, 'switch', '-q', 'main');
  r = run('push', '9');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /runbook push 9: check out issue\/9 first \(on main\)/);
  commit(root, { 'server/config.yml': 'a: live\n' });
  r = run('push', '9', '--plan');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /main changed config\.yml after issue\/9 was cut/);
  r = run('rollback', '9');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no push journal for issue 9/);
  r = check(root, {}, 'run', 'x', '--plan');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--plan is for runbook push/);
});

test('a push set with nothing under server/ pushes nothing and needs no SFTP', () => {
  const root = repo();
  commit(root, { 'checks/9-x/profile.json': '{"kind":"e2e"}\n' });
  const r = check(root, {}, 'runbook', 'push', '9');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not pushed: checks\/9-x\/profile\.json\nrunbook: nothing under server\/ to push for issue\/9/);
});
