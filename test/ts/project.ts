// Helpers for the bin/check tests: a temp project shaped like the private
// repo (harness/ mapped as #harness/*, a tracked server/, branch issue/3), a
// fake docker for one running pod, and a bin/check runner.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

// A project like the private repo: a tracked server/ and .verify/, on branch
// issue/3. '#harness/*' needs no mapping: bin/check run's loader pins it.
export function project(files: Record<string, string>): string {
  const root = tmp();
  git(root, 'init', '-q', '-b', 'issue/3');
  write(root, { 'package.json': '{"type":"module"}\n', '.gitignore': '.dev/\n' });
  commit(root, { 'server/config.yml': "crate:\n  name: 'Vote Crate'\n", ...files });
  return root;
}

// A docker stand-in for one running pod: labels from FAKE_LABELS, files from
// FAKE_FS (exec cat, test -e, touch, cp and the run log), relay requests
// logged to FAKE_FS/.relay-requests (bot.quitAll always ok), the relay's reply from
// FAKE_REPLY, logs from FAKE_LOG. FAKE_SERVER empty: no such container. The
// values are baked into the script: checks run with an allow-listed env.
export function fakeDocker(fake: Record<string, string>): string {
  const f = join(tmp(), 'docker');
  const vars = Object.entries(fake).map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(f, `#!/bin/sh
${vars}
case "$1" in
  inspect) [ -n "$FAKE_SERVER" ] || exit 1
    case "$3" in *Labels*) echo "$FAKE_LABELS" ;; *.Id*) echo cid123 ;; *) echo "$FAKE_SERVER" ;; esac ;;
  exec) case "$2" in -i) case "$4" in sh) cat >>"$FAKE_FS/.mc-harness-runs" ;; *) req=$(cat); printf '%s\n' "$req" >>"$FAKE_FS/.relay-requests"
      case "$req" in *'"bot.quitAll"'*) printf '{"ok":true,"quit":[]}' ;; *) printf '%s' "$FAKE_REPLY" ;; esac ;; esac ;; *)
    case "$3" in cat) cat "$FAKE_FS/\${4#/server/}" ;; touch) touch "$FAKE_FS/\${4#/server/}" ;; test) [ -e "$FAKE_FS/\${5#/server/}" ] ;; esac ;; esac ;;
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
  mkdirSync(fs, { recursive: true });
  const fake: Record<string, string> = { FAKE_SERVER: 'running', FAKE_LABELS: JSON.stringify(LABELS), FAKE_FS: fs, FAKE_REPLY: '', FAKE_LOG: '' };
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) (k.startsWith('FAKE_') ? fake : rest)[k] = v;
  return spawnSync(join(HARNESS_ROOT, 'bin/check'), args, {
    env: { ...ENV, MC_HOME: root, MC_DOCKER: fakeDocker(fake), ...rest },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

export const E2E = { 'checks/3-motd/profile.json': '{"kind":"e2e"}\n' };
