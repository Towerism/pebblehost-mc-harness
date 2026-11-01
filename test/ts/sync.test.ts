// bin/dev sync and seed without SFTP, over a fake rclone: a file live
// rewrites during the copy fails the sync once, quoting rclone's line and
// saying to run it again (one attempt, no loop, no drift commit), and a
// --with-data path a skip rule covers is refused before anything runs. The
// incremental sync's listing parse, window, diff and jar key, and its timing
// line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../../src/dev/image.ts';
import { diffListing, jarKey, parseListing, timing, windowStart } from '../../src/sync/sync.ts';
import { commit, ENV, git, tmp } from './project.ts';

function setup(): { root: string; log: string; dev: (...args: string[]) => ReturnType<typeof spawnSync> } {
  const dir = tmp();
  const log = join(dir, 'log');
  mkdirSync(join(dir, 'bin'));
  // Live has plugins/Eco/stats.yml; copying it fails the way rclone reports
  // a source that changed size mid-transfer.
  writeFileSync(join(dir, 'bin', 'rclone'), `#!/usr/bin/env bash
echo "$*" >>'${log}'
case $1 in
  obscure) cat >/dev/null; echo X ;;
  lsf) if [[ $* == *' -R '* ]]; then echo '10|2026-11-01 12:00:00|plugins/Eco/stats.yml'; elif [[ \${*: -1} == pebble: ]]; then echo 'plugins/'; fi ;;
  copyto) echo '2026/11/01 12:00:00 ERROR : Eco/stats.yml: corrupted on transfer: sizes differ 10 vs 14' >&2; exit 1 ;;
esac
exit 0
`);
  chmodSync(join(dir, 'bin', 'rclone'), 0o755);
  const root = join(dir, 'proj');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  commit(root, { '.gitignore': '.env\n.dev/\n', '.env': 'PEBBLE_SFTP_HOST=h\nPEBBLE_SFTP_USER=u\nPEBBLE_PANEL_PASSWORD=p\n', 'server/server.properties': 'motd=x\n' });
  git(root, 'switch', '-q', '-c', 'work');
  const env = { ...ENV, MC_HOME: root, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
  return { root, log, dev: (...args) => spawnSync(join(HARNESS_ROOT, 'bin/dev'), args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }) };
}

test('a file live rewrites during the copy fails the sync once, quoting the file and saying to run it again; no drift commit', () => {
  const { root, log, dev } = setup();
  const r = dev('sync');
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(String(r.stderr), /pull of plugins failed; live rewrote files during the copy:\n.*ERROR : Eco\/stats\.yml: corrupted on transfer: sizes differ 10 vs 14\nrun it again/);
  assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('copyto')).length, 1);
  assert.doesNotMatch(git(root, 'log', '--format=%s', 'main').stdout, /live drift/);
});

test('seed --with-data refuses a skip path before syncing or switching branches', () => {
  const { root, log, dev } = setup();
  const r = dev('seed', '5', '--with-data', 'plugins/ajLeaderboards/past-resets', '--no-boot');
  assert.equal(r.status, 2);
  assert.match(String(r.stderr), /--with-data plugins\/ajLeaderboards\/past-resets: sync-rules skip plugins\/ajLeaderboards\/past-resets\/ covers it/);
  assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'work');
  assert.throws(() => readFileSync(log, 'utf8'));
});

test('parseListing reads bin/mc ls -R -l lines, keeping spaces in names', () => {
  const out = '          12  2026-11-01 12:00:00  plugins/Eco/config.yml\n           0  2026-10-01 00:00:00   lead space.yml\n\n';
  assert.deepEqual(parseListing(out), {
    'plugins/Eco/config.yml': { size: 12, time: '2026-11-01 12:00:00' },
    ' lead space.yml': { size: 0, time: '2026-10-01 00:00:00' },
  });
});

test('the window starts 120 s before the listing start or the newest live mtime, whichever is earlier', () => {
  const start = Date.parse('2026-11-01T12:00:00Z') / 1000;
  const files = { a: { size: 1, time: '2026-11-01 11:00:00' }, b: { size: 1, time: '2026-11-01 11:30:00' } };
  assert.equal(windowStart(start, files), Date.parse('2026-11-01T11:28:00Z') / 1000);
  // Live's clock ahead of this machine's: the listing start bounds it.
  assert.equal(windowStart(start, { c: { size: 1, time: '2026-11-01 12:05:00' } }), start - 120);
  assert.equal(windowStart(start, {}), start - 120);
});

test('diffListing fetches new, resized and re-dated files, re-checks unchanged ones inside the window, and removes files gone from live', () => {
  const since = Date.parse('2026-11-01T12:00:08Z') / 1000;
  const prev = {
    same: { size: 1, time: '2026-11-01 11:00:00' },
    resized: { size: 1, time: '2026-11-01 11:00:00' },
    redated: { size: 1, time: '2026-11-01 11:00:00' },
    edge: { size: 1, time: '2026-11-01 12:00:08' },
    before: { size: 1, time: '2026-11-01 12:00:07' },
    gone: { size: 1, time: '2026-11-01 11:00:00' },
  };
  const next = {
    same: { size: 1, time: '2026-11-01 11:00:00' },
    resized: { size: 2, time: '2026-11-01 11:00:00' },
    redated: { size: 1, time: '2026-11-01 11:00:01' },
    edge: { size: 1, time: '2026-11-01 12:00:08' },
    before: { size: 1, time: '2026-11-01 12:00:07' },
    added: { size: 1, time: '2026-11-01 11:00:00' },
  };
  assert.deepEqual(diffListing(prev, next, since), { fetch: ['added', 'redated', 'resized'], recheck: ['edge'], remove: ['gone'] });
  assert.deepEqual(diffListing(next, next, Date.parse('2026-11-02T00:00:00Z') / 1000), { fetch: [], recheck: [], remove: [] });
});

test('the jar-roots key covers root jars and top-level plugins/*.jar only', () => {
  const base = { 'purpur.jar': { size: 1, time: '2026-11-01 11:00:00' }, 'plugins/Eco.jar': { size: 1, time: '2026-11-01 11:00:00' }, 'plugins/Eco/lib.jar': { size: 1, time: '2026-11-01 11:00:00' }, 'plugins/Eco/config.yml': { size: 1, time: '2026-11-01 11:00:00' } };
  const key = jarKey(base);
  assert.notEqual(jarKey({ ...base, 'plugins/Eco.jar': { size: 2, time: '2026-11-01 11:00:00' } }), key);
  assert.notEqual(jarKey({ ...base, 'plugins/New.JAR': { size: 1, time: '2026-11-01 11:00:00' } }), key);
  assert.notEqual(jarKey({ ...base, 'purpur.jar': { size: 1, time: '2026-11-01 11:00:01' } }), key);
  assert.equal(jarKey({ ...base, 'plugins/Eco/lib.jar': { size: 9, time: '2026-11-01 11:00:00' }, 'plugins/Eco/config.yml': { size: 9, time: '2026-11-01 11:00:00' } }), key);
});

test('the timing line warns OVER BUDGET only for an incremental sync with no changed files past 30 s', () => {
  assert.equal(timing(12.34, true, 0), 'sync: done in 12.3s');
  assert.match(timing(31, true, 0), /^sync: done in 31\.0s\nsync: OVER BUDGET: an incremental sync with no changed files took over 30s/);
  assert.equal(timing(31, true, 3), 'sync: done in 31.0s');
  assert.equal(timing(300, false, 0), 'sync: done in 300.0s');
});
