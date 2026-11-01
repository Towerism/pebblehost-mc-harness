// bin/check run and suite with --target live, without SFTP: the console, a
// restart and bots are refused; a declared need skips that test, an
// undeclared one fails it; a run where nothing ran exits 2. The SFTP reads
// themselves are in test/integration/target-live.bats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRecords } from '../../src/check/record.ts';
import { check, project } from './project.ts';

const T = (body: string) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dev } from '#harness/dev';\nimport { bot } from '#harness/bot';\n${body}\n`;

const checks = {
  'checks/3-needs/profile.json': '{"kind":"e2e","needs":["console","bot"]}\n',
  'checks/3-needs/a.test.ts': T("test('console', async () => { await dev.console('list'); });\ntest('bot', async () => { await bot.join('Steve'); });\ntest('restart', async () => { await dev.restart(); });\ntest('reads', () => assert.equal(1 + 1, 2));"),
  'checks/3-undeclared/profile.json': '{"kind":"e2e"}\n',
  'checks/3-undeclared/a.test.ts': T("test('console', async () => { await dev.console('list'); });\ntest('reads', () => assert.ok(true));"),
  'checks/3-restart/profile.json': '{"kind":"e2e","restart":true}\n',
  'checks/3-restart/a.test.ts': T("test('restart', async () => { await dev.restart(); });\ntest('reads', () => assert.ok(true));"),
  'checks/3-norestart/profile.json': '{"kind":"e2e"}\n',
  'checks/3-norestart/a.test.ts': T("test('reset', async () => { await dev.reset(); });\ntest('reads', () => assert.ok(true));"),
  'checks/3-allskip/profile.json': '{"kind":"e2e","needs":["bot"]}\n',
  'checks/3-allskip/a.test.ts': T("test('bot only', async () => { const b = await bot.join('Steve'); await b.chat('hi'); });"),
};

test('a live run skips tests whose declared need is missing, fails undeclared ones, and records target live', () => {
  const root = project(checks);
  let r = check(root, {}, 'run', '3-needs', '--target', 'live');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /run: 3-needs passed \(e2e, live, read-only\)/);
  const [rec] = readRecords(root, 3);
  assert.deepEqual([rec.target, rec.pass, rec.source, rec.generation, rec.runIndex], ['live', true, 'live', '', 0]);
  r = check(root, {}, 'run', '3-undeclared', '--target', 'live');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /dev\.console\(\) is not available on the live target, and the check's profile\.json doesn't declare "needs": \["console"\]/);
  assert.equal(readRecords(root, 3)[1].pass, false);
  r = check(root, {}, 'run', '3-allskip', '--target', 'live');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /checks\/3-allskip ran no test on live \(1 skipped: they need the console or a bot\); nothing recorded/);
  assert.equal(readRecords(root, 3).length, 2);
  // A restart is skipped when the profile declares "restart", fails otherwise.
  r = check(root, {}, 'run', '3-restart', '--target', 'live');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = check(root, {}, 'run', '3-norestart', '--target', 'live');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /dev\.reset\(\) is not available on the live target, and the check's profile\.json doesn't declare "restart": true/);
  // Live records never count for the gate, and the gate takes no live target.
  r = check(root, {}, 'gate', '3-needs', '--target', 'live');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gate works on dev records only/);
  r = check(root, {}, 'run', '3-needs', '--target', 'staging');
  assert.match(r.stderr, /--target is dev or live, not staging/);
});

test('the live suite runs every check read-only: PASS, FAIL and SKIP; nothing ran at all exits 2', () => {
  const root = project(checks);
  let r = check(root, {}, 'suite', '--target', 'live');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^SKIP 3-allskip/m);
  assert.match(r.stdout, /^PASS 3-needs \(.*3 test\(s\) skipped\)/m);
  assert.match(r.stdout, /^FAIL 3-undeclared/m);
  assert.match(r.stdout, /^live 3-allskip +\S+ skip$/m);
  assert.match(r.stdout, /^PASS 3-restart/m);
  assert.match(r.stdout, /suite \(live, read-only\): 5 check\(s\), 2 failed or refused \(3-norestart, 3-undeclared\); 0 pod\(s\)/);
  const only = project({ 'checks/3-allskip/profile.json': checks['checks/3-allskip/profile.json'], 'checks/3-allskip/a.test.ts': checks['checks/3-allskip/a.test.ts'] });
  r = check(only, {}, 'suite', '--target', 'live');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /suite: no check ran a test on live: every test needs the console or a bot/);
});
