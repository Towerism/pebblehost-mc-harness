// Unit tests for the suite (src/check/{profile,suite,timings}.ts): profile
// validation, grouping and the reset plan, the restart declaration, the
// timings table and the budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '../../src/check/dev.ts';
import { isData, readProfile, sqliteFixtures, type Profile } from '../../src/check/profile.ts';
import { checkEnv } from '../../src/check/run.ts';
import { planSuite, teardownSuitePods, type SuiteCheck } from '../../src/check/suite.ts';
import type { Docker } from '../../src/dev/docker.ts';
import { killOrphanSuite, podOf, suitePidFile } from '../../src/dev/pod.ts';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { formatTimings, readBudget, type Timings } from '../../src/check/timings.ts';
import { join } from 'node:path';
import { check, project, tmp, write } from './project.ts';

const P = (o: Partial<Profile> = {}): Profile => ({ kind: 'e2e', fixtures: [], data: [], needs: [], restart: false, exclusive: false, sqlite: {}, ...o });
const C = (id: string, o: Partial<Profile> = {}, fixturesHash = 'none', hasData = false): SuiteCheck => ({ id, profile: P(o), fixturesHash, hasData });

test('readProfile fills defaults and refuses anything malformed', () => {
  const root = tmp();
  write(root, { 'checks/a/profile.json': '{"kind":"e2e"}' });
  assert.deepEqual(readProfile(root, 'a'), P());
  const bad: [string, RegExp][] = [
    ['{"kind":"e2e","fixture":["x"]}', /unknown key fixture/],
    ['{"kind":"e2e","fixtures":["/abs"]}', /fixtures must be directories relative to the check/],
    ['{"kind":"e2e","fixtures":["../x"]}', /fixtures must be directories/],
    ['{"kind":"e2e","data":"x"}', /data must be paths/],
    ['{"kind":"e2e","needs":["shell"]}', /needs may hold only "console" and "bot"/],
    ['{"kind":"e2e","restart":"yes"}', /restart and exclusive must be true or false/],
    ['{"kind":"bare-text","fixtures":["f"]}', /a bare-text check takes no fixtures/],
    ['[]', /not an object/],
  ];
  for (const [json, re] of bad) {
    write(root, { 'checks/b/profile.json': json });
    assert.throws(() => readProfile(root, 'b'), re, json);
  }
});

test('readProfile: sqlite maps server database paths to SQL files in the check', () => {
  const root = tmp();
  write(root, { 'checks/a/profile.json': '{"kind":"e2e","sqlite":{"plugins/E/data.db":"economy.sql","x.sqlite3":"sql/x.sql"}}', 'checks/a/economy.sql': '', 'checks/a/sql/x.sql': '' });
  const p = readProfile(root, 'a');
  assert.deepEqual(p.sqlite, { 'plugins/E/data.db': 'economy.sql', 'x.sqlite3': 'sql/x.sql' });
  assert.deepEqual(sqliteFixtures(root, 'a', p), { 'plugins/E/data.db': join(root, 'checks/a/economy.sql'), 'x.sqlite3': join(root, 'checks/a/sql/x.sql') });
  write(root, { 'checks/c/profile.json': '{"kind":"e2e","sqlite":{"d.db":"missing.sql"}}' });
  assert.throws(() => sqliteFixtures(root, 'c', readProfile(root, 'c')), /sqlite missing\.sql is not a file in the check/);
  write(root, { 'checks/c/profile.json': '{"kind":"e2e","sqlite":{"d.db":"sql"}}', 'checks/c/sql/x.sql': '' });
  assert.throws(() => sqliteFixtures(root, 'c', readProfile(root, 'c')), /sqlite sql is not a file in the check/);
  const bad: [string, RegExp][] = [
    ['{"kind":"e2e","sqlite":["a.db"]}', /sqlite must map database paths to SQL files/],
    ['{"kind":"e2e","sqlite":{"a.db":1}}', /sqlite must map database paths to SQL files/],
    ['{"kind":"e2e","sqlite":{"/abs.db":"a.sql"}}', /sqlite key \/abs\.db must be a server path relative to the root ending \.db, \.sqlite or \.sqlite3/],
    ['{"kind":"e2e","sqlite":{"../a.db":"a.sql"}}', /sqlite key \.\.\/a\.db must be/],
    ['{"kind":"e2e","sqlite":{"plugins/E/data.yml":"a.sql"}}', /sqlite key plugins\/E\/data\.yml must be/],
    ['{"kind":"e2e","sqlite":{"a.db":"../a.sql"}}', /sqlite value \.\.\/a\.sql must be a path relative to the check/],
    ['{"kind":"e2e","sqlite":{"a.db":""}}', /sqlite value  must be a path relative to the check/],
    ['{"kind":"e2e","sqlite":{"./x.db":"a.sql"}}', /sqlite key \.\/x\.db must be/],
    ['{"kind":"e2e","sqlite":{"plugins/E/./keep.db":"a.sql"}}', /sqlite key plugins\/E\/\.\/keep\.db must be/],
    ['{"kind":"e2e","sqlite":{"plugins//keep.db":"a.sql"}}', /sqlite key plugins\/\/keep\.db must be/],
    ['{"kind":"e2e","sqlite":{"a\\nb.db":"a.sql"}}', /sqlite key a\\u000ab\.db must be/],
    ['{"kind":"e2e","sqlite":{"a.db":"./a.sql"}}', /sqlite value \.\/a\.sql must be/],
    ['{"kind":"e2e","sqlite":{"a.db":"sql//a.sql"}}', /sqlite value sql\/\/a\.sql must be/],
    ['{"kind":"e2e","sqlite":{"a.db":"sql/"}}', /sqlite value sql\/ must be/],
    ['{"kind":"e2e","sqlite":{"a.db":"a\\u0007.sql"}}', /sqlite value a\\u0007\.sql must be/],
    ['{"kind":"bare-text","sqlite":{"a.db":"a.sql"}}', /a bare-text check takes no fixtures, data, needs, restart, exclusive or sqlite/],
  ];
  for (const [json, re] of bad) {
    write(root, { 'checks/b/profile.json': json });
    assert.throws(() => readProfile(root, 'b'), re, json);
  }
});

test('isData: databases always, declared data paths and everything under them', () => {
  const p = P({ data: ['plugins/X/storage/', 'plugins/Y/players.yml'] });
  for (const rel of ['plugins/A/data.db', 'plugins/A/data.db-wal', 'x.sqlite', 'plugins/X/storage/u.json', 'plugins/Y/players.yml']) assert.ok(isData(rel, p), rel);
  for (const rel of ['plugins/A/config.yml', 'plugins/Y/players.yml.bak', 'plugins/X/storage-old/u.json']) assert.ok(!isData(rel, p), rel);
});

test('planSuite: bare-text first; one pod per fixture profile; exclusive alone; restart checks last; data resets by restart', () => {
  const plan = planSuite([
    C('b-list'),
    C('a-diff'),
    C('u-crate', { kind: 'bare-text' }),
    C('d-restart', { restart: true, fixtures: ['fx'] }, 'h1'),
    C('c-fx', { fixtures: ['fx'] }, 'h1'),
    C('e-fx', { fixtures: ['other'] }, 'h1'),
    C('f-alone', { exclusive: true }),
    C('g-db', { fixtures: ['fx'] }, 'h2', true),
  ]);
  assert.deepEqual(plan.unit, ['u-crate']);
  assert.deepEqual(plan.groups, [
    { key: 'fixtures:none', checks: ['a-diff', 'b-list'], reset: 'none' },
    { key: 'fixtures:h1', checks: ['c-fx', 'e-fx', 'd-restart'], reset: 'restore' },
    { key: 'exclusive:f-alone', checks: ['f-alone'], reset: 'none' },
    { key: 'fixtures:h2', checks: ['g-db'], reset: 'reset' },
  ]);
  // Boots equal the distinct profiles (plus one per exclusive check).
  assert.equal(plan.groups.length, 4);
});

test('dev.restart and dev.reset refuse a check that did not declare restart or exclusive', async () => {
  const saved = { ...process.env };
  try {
    process.env.MC_HOME = tmp();
    delete process.env.MC_RESTART_OK;
    await assert.rejects(dev.restart(), /dev\.restart\(\) needs "restart": true or "exclusive": true/);
    await assert.rejects(dev.reset(), /dev\.reset\(\) needs/);
  } finally {
    process.env = saved;
  }
  const root = project({ 'checks/x/profile.json': '{"kind":"e2e"}\n' });
  assert.equal(checkEnv(root, 'x', 'dev', 'c', P()).MC_RESTART_OK, undefined);
  assert.equal(checkEnv(root, 'x', 'dev', 'c', P({ restart: true })).MC_RESTART_OK, '1');
  assert.equal(checkEnv(root, 'x', 'dev', 'c', P({ exclusive: true })).MC_RESTART_OK, '1');
});

const T = (o: Partial<Timings> = {}): Timings => ({ started: 't', target: 'dev', commit: 'c', image: { cacheHit: true, seconds: 0.1 }, unit: [{ check: 'u', pass: true, seconds: 0.3 }], profiles: [{ pod: 'suite0', key: 'k', reset: 'none', boot: 12.34, teardown: 1, tests: [{ check: 'a', pass: true, seconds: 0.5 }, { check: 'b', pass: false, seconds: 0.7 }] }], refused: [{ check: 'c', reason: 'fixture conflict: x\nmore' }], total: 20, budget: null, over: null, ...o });

test('formatTimings prints every phase, the budget and OVER BUDGET', () => {
  const out = formatTimings(T());
  for (const part of [/^image \(cache hit\) +0\.1s$/m, /^unit u +0\.3s pass$/m, /^boot suite0 \(2 check\(s\), reset: none\) +12\.3s$/m, /^ {2}b +0\.7s FAIL$/m, /^teardown suite0 +1\.0s$/m, /^refused c +fixture conflict: x$/m, /^total +20\.0s$/m]) assert.match(out, part);
  assert.doesNotMatch(out, /OVER BUDGET/);
  assert.match(formatTimings(T({ budget: 15, over: 5 })), /total +20\.0s \(budget 15\.0s\)\nOVER BUDGET by 5\.0s$/);
});

test('readBudget: absent is none; checks/budget.json needs positive seconds', () => {
  const root = tmp();
  assert.equal(readBudget(root), null);
  write(root, { 'checks/budget.json': '{"seconds": 45}' });
  assert.equal(readBudget(root), 45);
  write(root, { 'checks/budget.json': '{"seconds": 0}' });
  assert.throws(() => readBudget(root), /seconds must be a positive number/);
});

test('bin/check suite refuses a project without checks and an id', () => {
  const root = project({});
  let r = check(root, {}, 'suite');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no checks\/<id>\/profile\.json to run/);
  r = check(root, {}, 'suite', 'x');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /suite takes no check id/);
});

const BARE = "import { test, bareText } from '#harness/unit';\ntest('name', () => bareText('config.yml', 'crate.name', 'Vote Crate'));\n";

test('one check that cannot run is refused alone; the rest of the suite runs and the exit is 1', () => {
  const root = project({
    'checks/3-crate/profile.json': '{"kind":"bare-text"}\n',
    'checks/3-crate/a.test.ts': BARE,
    'checks/3-bad/profile.json': '{"kind":"e2e","fixtures":["a","b"]}\n',
    'checks/3-bad/a.test.ts': "import { test } from 'node:test';\ntest('x', () => {});\n",
    'checks/3-bad/a/same.txt': 'one\n',
    'checks/3-bad/b/same.txt': 'two\n',
  });
  const r = check(root, {}, 'suite');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^REFUSED 3-bad: fixture conflict: same\.txt differs/m);
  assert.match(r.stdout, /^PASS 3-crate/m);
  assert.match(r.stdout, /^refused 3-bad +fixture conflict/m);
  assert.match(r.stdout, /suite: 2 check\(s\), 1 failed or refused \(3-bad\); 0 pod\(s\)/);
});

test('teardownSuitePods removes the suite<N> pods of this project by label and nothing else', () => {
  const root = tmp();
  const calls: string[][] = [];
  const d: Docker = (args) => {
    calls.push(args);
    const out = args.includes('--format') ? 'suite0\ndev\nsuite12\n\n' : args[0] === 'ps' || args.includes('-q') ? 'x1\n' : '';
    return { status: 0, stdout: out, stderr: '' };
  };
  assert.equal(teardownSuitePods(root, d), 6);
  const project = podOf(root, 'dev').project;
  const filters = calls.filter((c) => c.includes('-q')).map((c) => c[c.length - 1]);
  assert.deepEqual([...new Set(filters)].sort(), ['label=mc-harness.pod=suite0', 'label=mc-harness.pod=suite12']);
  assert.ok(calls.every((c) => !c.includes('-q') || c.includes(`label=mc-harness.project=${project}`)));
});

test('killOrphanSuite kills the group of the recorded suite child only when /proc shows it is that child', async () => {
  const root = realpathSync(tmp());
  write(root, { '.dev/.keep': '' });
  const start = (env: Record<string, string>) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', ...env } });
  const exited = (c: ReturnType<typeof start>) => new Promise((r) => c.on('exit', (_, sig) => r(sig)));
  const orphan = start({ MC_SUITE_CHILD: '1', MC_HOME: root });
  const other = start({ MC_HOME: root });
  await new Promise((r) => setTimeout(r, 100));
  write(root, { '.dev/suite.pid': `${other.pid}\n` });
  assert.equal(killOrphanSuite(root), false, 'a process that is not a suite child is left alone');
  write(root, { '.dev/suite.pid': `${orphan.pid}\n` });
  assert.equal(killOrphanSuite(root), true);
  assert.equal(await exited(orphan), 'SIGKILL');
  assert.equal(killOrphanSuite(root), false, 'the pidfile is gone');
  assert.equal(suitePidFile(root), join(root, '.dev', 'suite.pid'));
  other.kill('SIGKILL');
  await exited(other);
});
