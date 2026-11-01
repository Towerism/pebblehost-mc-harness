// bin/dev sync and seed without SFTP, over a fake rclone: a file live
// rewrites during the copy fails the sync once, quoting rclone's line and
// saying to run it again (one attempt, no loop, no drift commit), and a
// --with-data path a skip rule covers is refused before anything runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../../src/dev/image.ts';
import { commit, ENV, git, tmp } from './project.ts';

function setup(): { root: string; log: string; dev: (...args: string[]) => ReturnType<typeof spawnSync> } {
  const dir = tmp();
  const log = join(dir, 'log');
  mkdirSync(join(dir, 'bin'));
  // Live has plugins/; copying it fails the way rclone reports a source
  // that changed size mid-transfer.
  writeFileSync(join(dir, 'bin', 'rclone'), `#!/usr/bin/env bash
echo "$*" >>'${log}'
case $1 in
  obscure) cat >/dev/null; echo X ;;
  lsf) [[ \${*: -1} == pebble: ]] && echo 'plugins/' ;;
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
