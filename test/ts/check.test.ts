// Unit tests for bin/check run (src/check/): records, refusals, e2e runs
// against a fake docker, bare-text runs, and the '#harness/dev' and
// '#harness/unit' APIs inside a temp project that imports them like the
// private repo does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HARNESS_ROOT } from '../../src/dev/image.ts';
import { markExplored, podOf } from '../../src/dev/pod.ts';
import { issueOf, readRecords, type RunRecord } from '../../src/check/record.ts';
import { readValue, yamlScalar } from '../../src/check/unit.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'check-test-'));
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

const git = (root: string, ...args: string[]) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { env: ENV, encoding: 'utf8' });

function commit(root: string, files: Record<string, string>) {
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
}

// A project like the private repo: harness/ (here a symlink to this checkout)
// mapped as #harness/*, a tracked server/, on branch issue/3.
function project(files: Record<string, string>): string {
  const root = tmp();
  git(root, 'init', '-q', '-b', 'issue/3');
  symlinkSync(HARNESS_ROOT, join(root, 'harness'));
  write(root, { 'package.json': '{"type":"module","imports":{"#harness/*":"./harness/src/check/*.ts"}}\n', '.gitignore': '.verify/\n.dev/\n' });
  commit(root, { 'server/config.yml': "crate:\n  name: 'Vote Crate'\n", ...files });
  return root;
}

// A docker stand-in for one running pod: labels from FAKE_LABELS, files from
// FAKE_FS (exec cat and cp), the relay's reply from FAKE_REPLY, logs from
// FAKE_LOG. FAKE_SERVER empty: no such container.
function fakeDocker(): string {
  const f = join(tmp(), 'docker');
  writeFileSync(f, `#!/bin/sh
case "$1" in
  inspect) [ -n "$FAKE_SERVER" ] || exit 1
    case "$3" in *Labels*) echo "$FAKE_LABELS" ;; *.Id*) echo cid123 ;; *) echo "$FAKE_SERVER" ;; esac ;;
  exec) case "$2" in -i) cat >/dev/null; printf '%s' "$FAKE_REPLY" ;; *) cat "$FAKE_FS/\${4#/server/}" ;; esac ;;
  cp) src=\${2#*:/server/}; [ -e "$FAKE_FS/$src" ] || exit 1; cp "$FAKE_FS/$src" "$3" ;;
  logs) printf '%s\\n' "$FAKE_LOG" ;;
esac
`);
  chmodSync(f, 0o755);
  return f;
}

const LABELS = { 'mc-harness.source': 'archive', 'mc-harness.commit': 'c0ffee', 'mc-harness.tree': 't1', 'mc-harness.harness': 'h1', 'mc-harness.image': 'i1', 'mc-harness.fixtures': 'f1', 'mc-harness.generation': 'gen-1', 'mc-harness.fresh': 'true' };

function check(root: string, env: Record<string, string>, ...args: string[]) {
  const fs = join(root, 'fakefs');
  return spawnSync(join(HARNESS_ROOT, 'bin/check'), args, {
    env: { ...ENV, MC_HOME: root, MC_DOCKER: fakeDocker(), FAKE_SERVER: 'running', FAKE_LABELS: JSON.stringify(LABELS), FAKE_FS: fs, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

const E2E = { 'checks/3-motd/profile.json': '{"kind":"e2e"}\n' };

test('issueOf reads issue/N or --issue, and refuses anything else', () => {
  const root = project({});
  assert.equal(issueOf(root), 3);
  assert.equal(issueOf(root, '12'), 12);
  assert.throws(() => issueOf(root, '0'), /bad --issue/);
  git(root, 'checkout', '-q', '-b', 'main');
  assert.throws(() => issueOf(root), /branch main is not issue\/N/);
});

test('an e2e run records what booted (container labels), not HEAD, and the check exit decides pass', () => {
  const root = project({
    ...E2E,
    'checks/3-motd/motd.test.ts': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('difficulty', async () => {
  assert.match(await dev.console('difficulty'), /Normal/);
  assert.equal(await dev.file('server.properties'), 'motd=hi\\n');
  assert.match(await dev.logSince(new Date()), /Done/);
});
`,
  });
  write(root, { 'fakefs/server.properties': 'motd=hi\n' });
  const base = { FAKE_LOG: '[Server thread/INFO]: Done (1.0s)!' };
  let r = check(root, { ...base, FAKE_REPLY: '{"ok":true,"reply":"The difficulty is Easy"}' }, 'run', '3-motd');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /run: 3-motd failed \(e2e, commit c0ffee, generation gen-1 \(fresh\)\)/);
  r = check(root, { ...base, FAKE_REPLY: '{"ok":true,"reply":"The difficulty is Normal"}' }, 'run', '3-motd');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [red, green] = readRecords(root, 3);
  const head = git(root, 'rev-parse', 'HEAD:checks/3-motd').stdout.trim();
  const expected: Partial<RunRecord> = { check: '3-motd', issue: 3, kind: 'e2e', target: 'dev', source: 'archive', commit: 'c0ffee', treeHash: 't1', harnessHash: 'h1', imageHash: 'i1', fixturesHash: 'f1', checkHash: head, generation: 'gen-1', fresh: true, explored: false, containerId: 'cid123', confirm: false };
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(red[k as keyof RunRecord], v, k);
    assert.deepEqual(green[k as keyof RunRecord], v, k);
  }
  assert.deepEqual([red.pass, green.pass], [false, true]);
  assert.match(red.output, /The difficulty is Easy/);
  assert.ok(!Number.isNaN(Date.parse(green.time)));
  // A human touched the volume: later records say so.
  markExplored(podOf(root, 'dev'), 'gen-1');
  r = check(root, { ...base, FAKE_REPLY: '{"ok":true,"reply":"The difficulty is Easy"}' }, 'run', '3-motd');
  assert.match(r.stdout, /explored: does not count as a red/);
  assert.equal(readRecords(root, 3)[2].explored, true);
});

test('run refuses with exit 2: uncommitted or missing check, no tests, zero tests, no pod, no issue', () => {
  const root = project({ ...E2E, 'checks/3-motd/a.test.ts': "import { test } from 'node:test';\ntest('ok', () => {});\n", 'checks/3-empty/profile.json': '{"kind":"e2e"}\n', 'checks/3-empty/a.test.ts': '\n', 'checks/3-none/profile.json': '{"kind":"e2e"}\n', 'checks/3-bad/profile.json': '{"kind":"unit"}\n' });
  const cases: [Record<string, string>, string[], RegExp][] = [
    [{}, ['run', 'nope'], /no checks\/nope\/profile\.json/],
    [{}, ['run', '../x'], /bad check id/],
    [{}, ['run', '3-bad'], /kind must be "e2e" or "bare-text"/],
    [{}, ['run', '3-none'], /has no \*\.test\.ts/],
    [{}, ['run', '3-empty'], /checks\/3-empty\/a\.test\.ts defines no test; nothing recorded/],
    [{ FAKE_SERVER: '' }, ['run', '3-motd'], /pod dev is not up/],
    [{}, ['run', '3-motd', '--issue', 'x'], /bad --issue/],
    [{}, ['run'], /run needs a check id/],
  ];
  for (const [env, args, msg] of cases) {
    const r = check(root, env, ...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, msg);
  }
  write(root, { 'checks/3-motd/a.test.ts': "import { test } from 'node:test';\ntest('edited', () => {});\n" });
  let r = check(root, {}, 'run', '3-motd');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /checks\/3-motd has uncommitted changes/);
  write(root, { 'checks/3-new/profile.json': '{"kind":"e2e"}\n' });
  git(root, 'add', 'checks/3-new');
  r = check(root, {}, 'run', '3-new');
  assert.match(r.stderr, /checks\/3-new has uncommitted changes/);
  assert.deepEqual(readRecords(root, 3), []);
});

test('a bare-text run reads the committed server/ through #harness/unit and records HEAD', () => {
  const bare = (literal: string) => `import { test, bareText } from '#harness/unit';\ntest('crate name', () => bareText('config.yml', 'crate.name', '${literal}'));\n`;
  const root = project({ 'checks/3-crate/profile.json': '{"kind":"bare-text"}\n', 'checks/3-crate/crate.test.ts': bare('Vote Crate') });
  let r = check(root, { FAKE_SERVER: '' }, 'run', '3-crate');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [rec] = readRecords(root, 3);
  assert.deepEqual([rec.kind, rec.pass, rec.source, rec.commit, rec.treeHash, rec.imageHash], ['bare-text', true, 'head', git(root, 'rev-parse', 'HEAD').stdout.trim(), git(root, 'rev-parse', 'HEAD:server').stdout.trim(), '']);
  commit(root, { 'checks/3-crate/crate.test.ts': bare('Vote crate') });
  r = check(root, {}, 'run', '3-crate');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /config\.yml crate\.name/);
  write(root, { 'server/config.yml': 'x: 1\n' });
  r = check(root, {}, 'run', '3-crate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /server\/ has uncommitted changes; a bare-text run reads HEAD/);
  r = check(root, {}, 'run', '3-crate', '--fresh');
  assert.match(r.stderr, /--fresh is for e2e checks/);
});

test('yamlScalar and readValue take single-line scalars only', () => {
  assert.equal(yamlScalar("  name: 'It''s'  # c"), "It's");
  assert.equal(yamlScalar('  name: "a\\"b"'), 'a"b');
  assert.equal(yamlScalar('  name: Vote Crate # comment'), 'Vote Crate');
  for (const line of ['  name: |', '  name: >-', '  name:', '  name: [a, b]', '  name: &x y', "  name: 'open"]) assert.equal(yamlScalar(line), null, line);
  const yml = 'a:\r\n  b:\r\n    c: x\r\n  d: |\r\n    long\r\n';
  assert.equal(readValue(yml, 'f.yml', 'a.b.c'), 'x');
  assert.throws(() => readValue(yml, 'f.yml', 'a.d'), /not a single-line scalar/);
  assert.throws(() => readValue(yml, 'f.yml', 'a.z'), /no a\.z/);
  assert.equal(readValue('#motd=no\nmotd=Hi there\n', 'server.properties', 'motd'), 'Hi there');
  assert.throws(() => readValue('motd=x\n', 'server.properties', 'pvp'), /no key pvp/);
});

test('dev.sqlite copies the database with its -wal and opens it read-only; server paths stay relative', () => {
  const root = project({
    ...E2E,
    'checks/3-motd/db.test.ts': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('rows', async () => {
  assert.deepEqual(await dev.sqlite('plugins/X/data.db', 'select v from t where k = ?', 'a'), [{ v: 'from wal' }]);
  await assert.rejects(dev.file('../etc/passwd'), /bad server path/);
  await assert.rejects(dev.sqlite('/abs.db', 'select 1'), /bad server path/);
});
`,
  });
  mkdirSync(join(root, 'fakefs/plugins/X'), { recursive: true });
  const db = new DatabaseSync(join(root, 'fakefs/plugins/X/data.db'));
  db.exec("pragma journal_mode=wal; pragma wal_autocheckpoint=0; create table t (k text, v text); insert into t values ('a', 'from wal')");
  const r = check(root, {}, 'run', '3-motd');
  db.close();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(readFileSync(join(root, '.verify/runs/issue-3.jsonl'), 'utf8').includes('"pass":true'));
});
