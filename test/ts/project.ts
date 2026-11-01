// Helpers for the bin/check tests: a temp project shaped like the private
// repo (harness/ mapped as #harness/*, a tracked server/, branch issue/3), a
// fake docker for one running pod, and a bin/check runner.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HARNESS_ROOT } from '../../src/dev/image.ts';

export const tmp = () => mkdtempSync(join(tmpdir(), 'check-test-'));
export const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

export const git = (root: string, ...args: string[]) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { env: ENV, encoding: 'utf8' });

export function commit(root: string, files: Record<string, string>) {
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
}

// A project like the private repo: harness/ (here a symlink to this checkout)
// mapped as #harness/*, a tracked server/, on branch issue/3.
export function project(files: Record<string, string>): string {
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
export function fakeDocker(): string {
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

export const LABELS = { 'mc-harness.source': 'archive', 'mc-harness.commit': 'c0ffee', 'mc-harness.tree': 't1', 'mc-harness.harness': 'h1', 'mc-harness.image': 'i1', 'mc-harness.fixtures': 'f1', 'mc-harness.generation': 'gen-1', 'mc-harness.fresh': 'true' };

export function check(root: string, env: Record<string, string>, ...args: string[]) {
  const fs = join(root, 'fakefs');
  return spawnSync(join(HARNESS_ROOT, 'bin/check'), args, {
    env: { ...ENV, MC_HOME: root, MC_DOCKER: fakeDocker(), FAKE_SERVER: 'running', FAKE_LABELS: JSON.stringify(LABELS), FAKE_FS: fs, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

export const E2E = { 'checks/3-motd/profile.json': '{"kind":"e2e"}\n' };
