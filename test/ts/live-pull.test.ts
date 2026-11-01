// bin/check run --target live against a fake rclone serving a local "live"
// tree: a live read pulls single files only (a directory, a trailing slash
// or a nested directory is refused before any copy), a database whose
// listing keeps changing during its pulls refuses the run, and a signal to
// bin/check stops the check and leaves no live run home behind. The real
// SFTP path is in test/integration/target-live.bats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readRecords } from '../../src/check/record.ts';
import { HARNESS_ROOT } from '../../src/dev/image.ts';
import { check, ENV, fakeDocker, LABELS, project, tmp, write } from './project.ts';

// A fake rclone over `live`: lsf lists one level (stp format, directories
// with a trailing /), copyto copies; every call is logged. With `tick`, each
// listing gives files a new modtime, as if live kept writing them.
function fakeLive(tick = false): { live: string; log: string; path: string } {
  const dir = tmp();
  const live = join(dir, 'live');
  const log = join(dir, 'log');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(live);
  writeFileSync(join(dir, 'bin', 'rclone'), `#!/usr/bin/env bash
echo "$*" >>'${log}'
case $1 in
  obscure) cat >/dev/null; echo X ;;
  lsf)
    p=\${*: -1}; d='${live}'/\${p#pebble:}
    n=$(cat '${dir}/count' 2>/dev/null || echo 0); echo $((n + 1)) >'${dir}/count'
    t='2026-01-01 00:00:00'; ${tick ? `t=$(printf '2026-01-01 00:%02d:00' $((n % 60)))` : ':'}
    [[ -d $d ]] || exit 0
    for f in "$d"/*; do
      [[ -e $f ]] || continue
      if [[ -d $f ]]; then echo "-1|$t|\${f##*/}/"; else echo "$(stat -c %s "$f")|$t|\${f##*/}"; fi
    done ;;
  copyto) src=\${*: -2:1} dst=\${*: -1}; mkdir -p "$(dirname "$dst")"; cp -r '${live}'/"\${src#pebble:}" "$dst" ;;
esac
`);
  chmodSync(join(dir, 'bin', 'rclone'), 0o755);
  return { live, log, path: `${join(dir, 'bin')}:${process.env.PATH}` };
}

const ENVFILE = { '.env': 'PEBBLE_SFTP_HOST=h\nPEBBLE_SFTP_USER=u\nPEBBLE_PANEL_PASSWORD=p\n' };
const T = (body: string) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dev } from '#harness/dev';\n${body}\n`;

test('a live read pulls single files: a directory, a trailing slash and a nested directory are refused before any copy', () => {
  const f = fakeLive();
  write(f.live, { 'upload/plugins/a.yml': 'a: 1\n', 'upload/secret/key.txt': 'SECRET\n', 'upload/b.yml': 'b: 2\n' });
  const root = project({
    ...ENVFILE,
    'checks/3-dir/profile.json': '{"kind":"e2e"}\n',
    'checks/3-dir/a.test.ts': T("test('dir', async () => { await dev.file('upload/plugins'); });\ntest('slash', async () => { await dev.file('upload/'); });"),
    'checks/3-nested/profile.json': '{"kind":"bare-text"}\n',
    'checks/3-nested/a.test.ts': "import { test, bareText } from '#harness/unit';\ntest('nested', () => bareText('upload/secret', 'a', 'b'));\n",
    'checks/3-file/profile.json': '{"kind":"e2e"}\n',
    'checks/3-file/a.test.ts': T("test('file', async () => assert.equal(await dev.file('upload/b.yml'), 'b: 2\\n'));"),
  });
  let r = check(root, { PATH: f.path }, 'run', '3-dir', '--target', 'live');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /upload\/plugins is a directory on live; a live read pulls single files only/);
  assert.match(r.stdout, /upload\/: a live read takes a file path \(no trailing \/, no empty or \. segment\), not a directory/);
  r = check(root, { PATH: f.path }, 'run', '3-nested', '--target', 'live');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /upload\/secret is a directory on live/);
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /copyto/);
  r = check(root, { PATH: f.path }, 'run', '3-file', '--target', 'live');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(f.log, 'utf8'), /copyto --ignore-times pebble:upload\/b\.yml /);
  assert.deepEqual(readdirSync(join(root, '.dev', 'live')), []);
});

test('dev.sqlite on live: a steady listing reads the database; one that changes during both pulls refuses the run, nothing recorded', () => {
  const q = T("test('rows', async () => assert.deepEqual(await dev.sqlite('plugins/Eco/data.db', 'select name from users'), [{ name: 'steve' }]));");
  for (const tick of [false, true]) {
    const f = fakeLive(tick);
    mkdirSync(join(f.live, 'plugins/Eco'), { recursive: true });
    const db = new DatabaseSync(join(f.live, 'plugins/Eco/data.db'));
    db.exec("create table users (name text); insert into users values ('steve')");
    db.close();
    const root = project({ ...ENVFILE, 'checks/3-db/profile.json': '{"kind":"e2e"}\n', 'checks/3-db/a.test.ts': q });
    const r = check(root, { PATH: f.path }, 'run', '3-db', '--target', 'live');
    if (!tick) {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      continue;
    }
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /checks\/3-db: live database changed during pull: plugins\/Eco\/data\.db \(with its -wal and -shm\) changed during both pulls; .*nothing recorded/);
    assert.equal(readRecords(root, 3).length, 0);
    assert.equal(readFileSync(f.log, 'utf8').split('\n').filter((l) => l.startsWith('copyto') && l.includes('data.db ')).length, 2);
  }
});

const SLEEPER = "import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('sleeps', async () => { writeFileSync(`${process.env.MC_HOME}/sleeper.pid`, String(process.pid)); await new Promise((r) => setTimeout(r, 20000)); });\n";

async function signalRun(root: string, env: Record<string, string>, args: string[], sig: NodeJS.Signals): Promise<{ status: number | null; out: string }> {
  const c = spawn(join(HARNESS_ROOT, 'bin/check'), args, { env: { ...ENV, MC_HOME: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (b) => (out += b));
  c.stderr.on('data', (b) => (out += b));
  for (let i = 0; i < 100 && !existsSync(join(root, 'sleeper.pid')); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(join(root, 'sleeper.pid')), out);
  c.kill(sig);
  const status = await new Promise<number | null>((r) => c.on('exit', r));
  return { status, out };
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test('SIGTERM or SIGINT to bin/check run --target live kills the check and removes its live home; a dev run kills its check too', async () => {
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    const root = project({ ...ENVFILE, 'checks/3-sleep/profile.json': '{"kind":"e2e"}\n', 'checks/3-sleep/a.test.ts': SLEEPER });
    const { status, out } = await signalRun(root, {}, ['run', '3-sleep', '--target', 'live'], sig);
    assert.equal(status, code, out);
    assert.match(out, new RegExp(`check: ${sig}: stopping the run\\nrun: ${sig}: stopped; nothing recorded; removed 1 live run home\\(s\\)`));
    assert.deepEqual(readdirSync(join(root, '.dev', 'live')), []);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(gone(Number(readFileSync(join(root, 'sleeper.pid'), 'utf8'))), 'the check process was killed');
    assert.equal(readRecords(root, 3).length, 0);
  }
  const root = project({ 'checks/3-sleep/profile.json': '{"kind":"e2e"}\n', 'checks/3-sleep/a.test.ts': SLEEPER });
  const fs = join(root, 'fakefs');
  mkdirSync(fs);
  const { status, out } = await signalRun(root, { MC_DOCKER: fakeDocker({ FAKE_SERVER: 'running', FAKE_LABELS: JSON.stringify(LABELS), FAKE_FS: fs, FAKE_REPLY: '', FAKE_LOG: '' }) }, ['run', '3-sleep'], 'SIGTERM');
  assert.equal(status, 143, out);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(gone(Number(readFileSync(join(root, 'sleeper.pid'), 'utf8'))), 'the dev check process was killed');
});

test('a live run sweeps run homes whose owner is gone, and keeps a live owner and a just-created home', () => {
  const f = fakeLive();
  write(f.live, { 'b.yml': 'b: 2\n' });
  const root = project({ ...ENVFILE, 'checks/3-file/profile.json': '{"kind":"e2e"}\n', 'checks/3-file/a.test.ts': T("test('file', async () => assert.equal(await dev.file('b.yml'), 'b: 2\\n'));") });
  const live = join(root, '.dev', 'live');
  // A pid that just exited is free; this process is alive.
  const dead = spawnSync('true').pid;
  write(live, { 'run-dead/.owner': `${dead}\n`, 'run-dead/server/secret.yml': 's\n', 'run-alive/.owner': `${process.pid}\n`, 'run-new/server/x': 'x\n', 'run-old/server/x': 'x\n' });
  utimesSync(join(live, 'run-old'), new Date(0), new Date(0));
  const r = check(root, { PATH: f.path }, 'run', '3-file', '--target', 'live');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readdirSync(live).sort(), ['run-alive', 'run-new']);
});
