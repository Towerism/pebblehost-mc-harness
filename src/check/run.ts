// bin/check run: run checks/<id>/*.test.ts with node --test against the pod
// (e2e) or the committed tree (bare-text), then append a run record.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot } from '../dev/cli.ts';
import { fail, type Docker } from '../dev/docker.ts';
import { dirtyServer, git, labels, source } from '../dev/image.ts';
import { isExplored, names, podOf, readPodFile, state } from '../dev/pod.ts';
import { appendRecord, type Kind, type RunRecord } from './record.ts';

export type Profile = { kind: Kind };

export function readProfile(root: string, id: string): Profile {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) fail(`bad check id ${id}`);
  const f = join(root, 'checks', id, 'profile.json');
  if (!existsSync(f)) fail(`no checks/${id}/profile.json`);
  let p: Profile;
  try {
    p = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    fail(`checks/${id}/profile.json is not JSON`);
  }
  if (p.kind !== 'e2e' && p.kind !== 'bare-text') fail(`checks/${id}/profile.json: kind must be "e2e" or "bare-text"`);
  return p;
}

// The git tree id of the committed checks/<id>/; refuses uncommitted changes,
// so a record always names a check the suite can run again.
export function checkHash(root: string, id: string): string {
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all', '--', `checks/${id}`]).stdout.trim();
  if (dirty) fail(`checks/${id} has uncommitted changes; commit them first:\n${dirty}`);
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

export function runCheck(o: RunOpts, d: Docker): Run {
  const { kind } = readProfile(o.root, o.id);
  const hash = checkHash(o.root, o.id);
  const entries = readdirSync(join(o.root, 'checks', o.id), { withFileTypes: true });
  const tests = entries.filter((e) => e.isFile() && e.name.endsWith('.test.ts')).map((e) => e.name).sort();
  if (tests.length === 0) fail(`checks/${o.id} has no *.test.ts`);
  // A bare-text check is its test files and profile.json; anything else (a
  // package.json, a helper module, a directory) could change what it runs.
  const extra = entries.filter((e) => !(e.isFile() && (e.name === 'profile.json' || e.name.endsWith('.test.ts')))).map((e) => e.name);
  if (kind === 'bare-text' && extra.length > 0) fail(`checks/${o.id} is bare-text: only profile.json and *.test.ts are allowed, not ${extra.join(', ')}`);
  const p = podOf(o.root, o.pod);
  let id: Pick<RunRecord, 'source' | 'commit' | 'treeHash' | 'harnessHash' | 'imageHash' | 'fixturesHash' | 'generation' | 'fresh' | 'explored' | 'containerId'>;
  if (kind === 'e2e') {
    if (o.fresh) boot(p, readPodFile(p), undefined, true, true);
    const server = names(p).server;
    const st = state(d, server);
    if (st !== 'running') fail(`pod ${o.pod} is ${st ?? 'not up'}; run bin/dev up, or bin/check run --fresh`);
    const l = labels(d, server);
    const gen = l['mc-harness.generation'] ?? '';
    const containerId = d(['inspect', '--format', '{{.Id}}', server]).stdout.trim();
    id = { source: l['mc-harness.source'] ?? '', commit: l['mc-harness.commit'] ?? '', treeHash: l['mc-harness.tree'] ?? '', harnessHash: l['mc-harness.harness'] ?? '', imageHash: l['mc-harness.image'] ?? '', fixturesHash: l['mc-harness.fixtures'] ?? '', generation: gen, fresh: l['mc-harness.fresh'] === 'true', explored: isExplored(p, d), containerId };
  } else {
    if (o.fresh) fail('--fresh is for e2e checks; a bare-text check needs no pod');
    const src = source(o.root);
    if (src.kind !== 'git') fail('a bare-text check reads the committed server/; server/ is not tracked');
    const dirty = dirtyServer(src);
    if (dirty.length > 0) fail(`server/ has uncommitted changes; a bare-text run reads HEAD, so commit them first:\n${dirty.join('\n')}`);
    id = { source: 'head', commit: src.commit, treeHash: git(o.root, ['rev-parse', `${src.commit}:server`]).stdout.trim(), harnessHash: '', imageHash: '', fixturesHash: '', generation: '', fresh: false, explored: false, containerId: '' };
  }
  const time = new Date().toISOString();
  const tmp = mkdtempSync(join(tmpdir(), 'check-'));
  try {
    const tap = join(tmp, 'tap');
    const files = tests.map((t) => `checks/${o.id}/${t}`);
    const env: Record<string, string> = { MC_HOME: o.root, MC_POD: o.pod, MC_TARGET: 'dev', MC_COMMIT: id.commit };
    for (const k of KEEP_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    const args = ['--import', LOADER, '--test', '--test-isolation=none', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tap}`, ...files];
    const r = spawnSync(process.execPath, args, {
      cwd: o.root,
      encoding: 'utf8',
      env,
      timeout: o.timeoutS * 1000,
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.error) fail(`node --test did not finish: ${r.error.message}\n${output}`);
    // node --test reports a file that defines no test as one passing test
    // named after the file: that run proves nothing.
    const top = [...(existsSync(tap) ? readFileSync(tap, 'utf8') : '').matchAll(/^(not )?ok \d+ - (.*)$/gm)];
    const empty = files.filter((f) => top.some((m) => !m[1] && m[2] === f));
    if (top.length === 0 || empty.length > 0) fail(`${empty.join(', ') || `checks/${o.id}`} defines no test; nothing recorded\n${output}`);
    const pass = r.status === 0 && top.every((m) => !m[1]);
    const record: RunRecord = { check: o.id, issue: o.issue, kind, target: 'dev', pass, time, ...id, checkHash: hash, confirm: o.confirm, output: output.trimEnd().split('\n').slice(-TAIL).join('\n') };
    appendRecord(o.root, record);
    return { record, output };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
