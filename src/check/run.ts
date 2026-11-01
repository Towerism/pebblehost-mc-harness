// bin/check run: run checks/<id>/*.test.ts with node --test against the pod
// (e2e) or the committed tree (bare-text), then append a run record.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot } from '../dev/cli.ts';
import { fail, type Docker } from '../dev/docker.ts';
import { dirtyHarness, dirtyServer, git, labels, source, toolHash } from '../dev/image.ts';
import { isExplored, logRun, names, podOf, readPodFile, runPosition, state, type Pod } from '../dev/pod.ts';
import { fixtureDirs, readProfile, type Profile } from './profile.ts';
import { appendRecord, type RunRecord } from './record.ts';

// The git tree id of the committed checks/<id>/; refuses uncommitted changes
// and any untracked or ignored file there, so a record always names a check
// the suite can run again.
export function checkHash(root: string, id: string): string {
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all', '--', `checks/${id}`]).stdout.trim();
  if (dirty) fail(`checks/${id} has uncommitted changes; commit them first:\n${dirty}`);
  const extra = git(root, ['ls-files', '--others', '--', `checks/${id}`]).stdout.trim();
  if (extra) fail(`checks/${id} holds untracked or ignored files; remove them or commit them:\n${extra}`);
  const r = git(root, ['rev-parse', '--verify', '-q', `HEAD:checks/${id}`]);
  if (r.status !== 0) fail(`checks/${id} is not committed`);
  return r.stdout.trim();
}

export type RunOpts = { root: string; id: string; issue: number; pod: string; fresh: boolean; confirm: boolean; timeoutS: number };

export type Run = { record: RunRecord; output: string };

const TAIL = 40;

// The only variables a check sees besides MC_*: no NODE_OPTIONS or other
// NODE_* that could preload code into the run, nothing else from the caller.
const KEEP_ENV = ['PATH', 'HOME', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'MC_DOCKER', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];
const LOADER = pathToFileURL(join(import.meta.dirname, 'loader.ts')).href;

export function refuseDirtyHarness(): void {
  const harness = dirtyHarness();
  if (harness.length > 0) fail(`the harness has uncommitted changes; commit them first:\n${harness.join('\n')}`);
}

// The committed test files of checks/<id> (tree `hash`), as paths from the
// project root. Refuses a symlink anywhere in the check, a check without
// tests, and anything but profile.json
// and *.test.ts in a bare-text check: a package.json, a helper module or a
// directory could change what it runs.
export function committedTests(root: string, id: string, hash: string, profile: Profile): string[] {
  // A committed symlink (mode 120000) would run or read code outside the check.
  const links = git(root, ['ls-tree', '-r', hash]).stdout.split('\n').filter((l) => l.startsWith('120000 ')).map((l) => `checks/${id}/${l.split('\t')[1]}`);
  if (links.length > 0) fail(`symlinks refused in checks/${id}: ${links.join(', ')}`);
  const tests = git(root, ['ls-tree', hash]).stdout.split('\n').map((l) => /^100\d+ blob \w+\t(.+\.test\.ts)$/.exec(l)?.[1]).filter((f): f is string => f !== undefined).sort();
  if (tests.length === 0) fail(`checks/${id} has no *.test.ts`);
  const extra = readdirSync(join(root, 'checks', id), { withFileTypes: true }).filter((e) => !(e.isFile() && (e.name === 'profile.json' || e.name.endsWith('.test.ts')))).map((e) => e.name);
  if (profile.kind === 'bare-text' && extra.length > 0) fail(`checks/${id} is bare-text: only profile.json and *.test.ts are allowed, not ${extra.join(', ')}`);
  return tests.map((t) => `checks/${id}/${t}`);
}

// The env a check runs with: MC_* and the allow-listed variables only.
// MC_RESTART_OK lets dev.restart() and dev.reset() run (profile restart or
// exclusive).
export function checkEnv(root: string, id: string, pod: string, commit: string, profile: Profile): Record<string, string> {
  const env: Record<string, string> = { MC_HOME: root, MC_POD: pod, MC_TARGET: 'dev', MC_COMMIT: commit, MC_CHECK_DIR: realpathSync(join(root, 'checks', id)) };
  if (profile.restart || profile.exclusive) env.MC_RESTART_OK = '1';
  for (const k of KEEP_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export type TestRun = { pass: boolean; output: string; seconds: number };

// node --test over the files with the #harness loader. Refuses (nothing to
// record) a refused import and a file that defines no test.
export function runTests(root: string, id: string, files: string[], env: Record<string, string>, timeoutS: number): TestRun {
  const t0 = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), 'check-'));
  try {
    const tap = join(tmp, 'tap');
    const args = ['--import', LOADER, '--test', '--test-isolation=none', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tap}`, ...files];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env, timeout: timeoutS * 1000, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.error) fail(`node --test did not finish: ${r.error.message}\n${output}`);
    const refused = output.split('\n').find((l) => l.includes('import refused:'));
    if (refused) fail(`checks/${id} imports from outside its directory; nothing recorded\n${refused.trim()}`);
    // node --test reports a file that defines no test as one passing test
    // named after the file: that run proves nothing.
    const top = [...(existsSync(tap) ? readFileSync(tap, 'utf8') : '').matchAll(/^(not )?ok \d+ - (.*)$/gm)];
    const empty = files.filter((f) => top.some((m) => !m[1] && m[2] === f));
    if (top.length === 0 || empty.length > 0) fail(`${empty.join(', ') || `checks/${id}`} defines no test; nothing recorded\n${output}`);
    return { pass: r.status === 0 && top.every((m) => !m[1]), output, seconds: (Date.now() - t0) / 1000 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function runCheck(o: RunOpts, d: Docker): Run {
  refuseDirtyHarness();
  const tool = toolHash();
  const profile = readProfile(o.root, o.id);
  const { kind } = profile;
  const hash = checkHash(o.root, o.id);
  const files = committedTests(o.root, o.id, hash, profile);
  const p = podOf(o.root, o.pod);
  let id: Pick<RunRecord, 'source' | 'commit' | 'treeHash' | 'harnessHash' | 'imageHash' | 'fixturesHash' | 'generation' | 'fresh' | 'explored' | 'containerId' | 'runIndex' | 'concurrent'>;
  const time = new Date().toISOString();
  // e2e: the run's line in the volume's run log; its position is read after the run.
  let logged: { pod: Pod; nonce: string } | null = null;
  if (kind === 'e2e') {
    // A fresh volume carries the check's own fixtures.
    if (o.fresh) boot(p, { ...readPodFile(p), fixtures: fixtureDirs(o.root, o.id, profile) }, undefined, true, true);
    const server = names(p).server;
    const st = state(d, server);
    if (st !== 'running') fail(`pod ${o.pod} is ${st ?? 'not up'}; run bin/dev up, or bin/check run --fresh`);
    const l = labels(d, server);
    const gen = l['mc-harness.generation'] ?? '';
    const containerId = d(['inspect', '--format', '{{.Id}}', server]).stdout.trim();
    id = { source: l['mc-harness.source'] ?? '', commit: l['mc-harness.commit'] ?? '', treeHash: l['mc-harness.tree'] ?? '', harnessHash: l['mc-harness.harness'] ?? '', imageHash: l['mc-harness.image'] ?? '', fixturesHash: l['mc-harness.fixtures'] ?? '', generation: gen, fresh: l['mc-harness.fresh'] === 'true', explored: isExplored(p, d), containerId, runIndex: 0, concurrent: false };
    logged = { pod: p, nonce: logRun(p, d, `${time} issue-${o.issue} ${o.id}${o.confirm ? ' confirm' : ''}`) };
  } else {
    if (o.fresh) fail('--fresh is for e2e checks; a bare-text check needs no pod');
    const src = source(o.root);
    if (src.kind !== 'git') fail('a bare-text check reads the committed server/; server/ is not tracked');
    const dirty = dirtyServer(src);
    if (dirty.length > 0) fail(`server/ has uncommitted changes; a bare-text run reads HEAD, so commit them first:\n${dirty.join('\n')}`);
    id = { source: 'head', commit: src.commit, treeHash: git(o.root, ['rev-parse', `${src.commit}:server`]).stdout.trim(), harnessHash: '', imageHash: '', fixturesHash: '', generation: '', fresh: false, explored: false, containerId: '', runIndex: 0, concurrent: false };
  }
  const { pass, output } = runTests(o.root, o.id, files, checkEnv(o.root, o.id, o.pod, id.commit, profile), o.timeoutS);
  if (logged) {
    const pos = runPosition(logged.pod, d, logged.nonce);
    id.runIndex = pos.index;
    id.concurrent = pos.index < 0 || pos.after > 0;
    id.explored ||= isExplored(logged.pod, d);
  }
  const record: RunRecord = { check: o.id, issue: o.issue, kind, target: 'dev', pass, time, ...id, checkHash: hash, toolHash: tool, confirm: o.confirm, output: output.trimEnd().split('\n').slice(-TAIL).join('\n') };
  appendRecord(o.root, record);
  return { record, output };
}
