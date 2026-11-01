// Unit tests for the suite (src/check/{profile,suite,timings}.ts): profile
// validation, grouping and the reset plan, the restart declaration, the
// timings table and the budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '../../src/check/dev.ts';
import { isData, readProfile, type Profile } from '../../src/check/profile.ts';
import { checkEnv } from '../../src/check/run.ts';
import { planSuite, type SuiteCheck } from '../../src/check/suite.ts';
import { formatTimings, readBudget, type Timings } from '../../src/check/timings.ts';
import { check, project, tmp, write } from './project.ts';

const P = (o: Partial<Profile> = {}): Profile => ({ kind: 'e2e', fixtures: [], data: [], needs: [], restart: false, exclusive: false, ...o });
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

const T = (o: Partial<Timings> = {}): Timings => ({ started: 't', commit: 'c', image: { cacheHit: true, seconds: 0.1 }, unit: [{ check: 'u', pass: true, seconds: 0.3 }], profiles: [{ pod: 'suite0', key: 'k', reset: 'none', boot: 12.34, teardown: 1, tests: [{ check: 'a', pass: true, seconds: 0.5 }, { check: 'b', pass: false, seconds: 0.7 }] }], total: 20, budget: null, over: null, ...o });

test('formatTimings prints every phase, the budget and OVER BUDGET', () => {
  const out = formatTimings(T());
  for (const part of [/^image \(cache hit\) +0\.1s$/m, /^unit u +0\.3s pass$/m, /^boot suite0 \(2 check\(s\), reset: none\) +12\.3s$/m, /^ {2}b +0\.7s FAIL$/m, /^teardown suite0 +1\.0s$/m, /^total +20\.0s$/m]) assert.match(out, part);
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
