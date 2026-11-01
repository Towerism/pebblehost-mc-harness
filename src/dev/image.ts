// The dev image: built from `git archive <commit> server/` (or, when server/
// is not tracked, a plain copy of it), tagged mc-dev:<imageHash> and labelled
// with the identity a run record reads back from the running container.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fail, must, type Docker } from './docker.ts';
import { applyOverrides } from './overrides.ts';

export const HARNESS_ROOT = resolve(import.meta.dirname, '../..');
// What the harness puts into an image besides the server tree.
export const HARNESS_INPUTS = ['docker/server.Dockerfile', 'docker/entrypoint.sh', 'src/dev/overrides.ts'];

export type Source = { kind: 'git'; root: string; commit: string } | { kind: 'dir'; root: string };
export type Identity = { commit: string; tree: string; harness: string; image: string };

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  return { status: r.status ?? 2, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mustGit(root: string, args: string[]): string {
  const r = git(root, args);
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// Relative paths of every file under dir, sorted. Symlinks are refused: they
// could pull host files into the image.
export function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, path));
    if (st.isSymbolicLink()) fail(`symlink refused: ${join(dir, path)}`);
    if (st.isDirectory()) out.push(...walk(dir, path));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

// sha256 over every file's path, mode and content.
export function dirHash(dir: string): string {
  const h = createHash('sha256');
  for (const rel of walk(dir)) {
    const mode = lstatSync(join(dir, rel)).mode & 0o777;
    h.update(`${mode.toString(8)} ${rel} ${sha256(readFileSync(join(dir, rel)))}\n`);
  }
  return h.digest('hex');
}

// git when server/ is tracked at HEAD, else a plain directory.
export function source(root: string): Source {
  if (git(root, ['ls-files', '--error-unmatch', '--', 'server']).status === 0) {
    if (git(root, ['rev-parse', '--verify', '-q', 'HEAD:server']).status !== 0) fail('server/ is staged but not committed; commit it first');
    return { kind: 'git', root, commit: mustGit(root, ['rev-parse', 'HEAD']) };
  }
  try {
    if (!lstatSync(join(root, 'server')).isDirectory()) throw new Error();
  } catch {
    fail(`no server/ in ${root}`);
  }
  return { kind: 'dir', root };
}

// Uncommitted changes under server/, as `git status --porcelain` lines.
export function dirtyServer(src: Source): string[] {
  if (src.kind === 'dir') return [];
  return mustGit(src.root, ['status', '--porcelain', '--untracked-files=all', '--', 'server']).split('\n').filter(Boolean);
}

export function treeHash(src: Source): string {
  return src.kind === 'git' ? mustGit(src.root, ['rev-parse', `${src.commit}:server`]) : dirHash(join(src.root, 'server'));
}

export function harnessHash(harnessRoot = HARNESS_ROOT): string {
  const h = createHash('sha256');
  for (const f of HARNESS_INPUTS) h.update(`${f}\n${sha256(readFileSync(join(harnessRoot, f)))}\n`);
  return h.digest('hex');
}

export function identity(src: Source, harnessRoot = HARNESS_ROOT): Identity {
  const tree = treeHash(src);
  const harness = harnessHash(harnessRoot);
  return { commit: src.kind === 'git' ? src.commit : 'none', tree, harness, image: sha256(`${tree}\n${harness}`) };
}

// Big, rarely changing files go to the first layer so a config-only change
// reuses it.
function isBin(rel: string): boolean {
  const top = rel.split('/')[0];
  return ['libraries', 'versions', 'cache'].includes(top) || rel.toLowerCase().endsWith('.jar');
}

// Lay out ctx/{bin,cfg,ovr} plus the Dockerfile and entrypoint. Returns the
// server jar: the one *.jar at the server root.
export function buildContext(src: Source, ctx: string, harnessRoot = HARNESS_ROOT): { jar: string; notes: string[] } {
  for (const d of ['bin', 'cfg', 'ovr']) mkdirSync(join(ctx, d), { recursive: true });
  let base: string;
  if (src.kind === 'git') {
    const links = mustGit(src.root, ['ls-tree', '-r', '--full-tree', src.commit, '--', 'server']).split('\n').filter((l) => l.startsWith('120000'));
    if (links.length > 0) fail(`symlinks refused in server/: ${links.map((l) => l.split('\t')[1]).join(', ')}`);
    mustGit(src.root, ['archive', '--format=tar', '-o', join(ctx, 'server.tar'), src.commit, 'server/']);
    const tar = spawnSync('tar', ['-xf', join(ctx, 'server.tar'), '-C', ctx], { encoding: 'utf8' });
    if (tar.status !== 0) fail(`tar failed: ${tar.stderr}`);
    rmSync(join(ctx, 'server.tar'));
    base = join(ctx, 'server');
  } else {
    base = join(src.root, 'server');
  }
  for (const rel of walk(base)) {
    const dest = join(ctx, isBin(rel) ? 'bin' : 'cfg', rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (src.kind === 'git') renameSync(join(base, rel), dest);
    else cpSync(join(base, rel), dest);
  }
  if (src.kind === 'git') rmSync(base, { recursive: true, force: true });
  const notes: string[] = [];
  for (const a of applyOverrides(join(ctx, 'cfg'))) {
    notes.push(a.note);
    if (a.content === null) continue;
    mkdirSync(dirname(join(ctx, 'ovr', a.file)), { recursive: true });
    writeFileSync(join(ctx, 'ovr', a.file), a.content);
  }
  cpSync(join(harnessRoot, 'docker/server.Dockerfile'), join(ctx, 'Dockerfile'));
  cpSync(join(harnessRoot, 'docker/entrypoint.sh'), join(ctx, 'entrypoint.sh'));
  const jars = readdirSync(join(ctx, 'bin')).filter((f) => f.toLowerCase().endsWith('.jar'));
  if (jars.length !== 1) fail(`server/ needs exactly one *.jar at its root, found ${jars.length ? jars.join(', ') : 'none'}`);
  return { jar: jars[0], notes };
}

// Whether the build output shows the step running `step` taken from cache:
// "Using cache" after it (classic builder) or "#<n> CACHED" (BuildKit).
export function stepCached(output: string, step: string): boolean {
  const lines = output.split('\n');
  const i = lines.findIndex((l) => l.includes(step));
  if (i < 0) return false;
  const bk = /^#(\d+) /.exec(lines[i]);
  if (bk) return lines.some((l) => l.trim() === `#${bk[1]} CACHED`);
  return lines.slice(i + 1).find((l) => l.trim() !== '')?.includes('Using cache') ?? false;
}

export type Built = { tag: string; id: Identity; cacheHit: boolean; jarLayerCached: boolean; notes: string[] };

export function build(src: Source, d: Docker, project: string, harnessRoot = HARNESS_ROOT): Built {
  const id = identity(src, harnessRoot);
  const tag = `mc-dev:${id.image}`;
  if (d(['image', 'inspect', tag]).status === 0) return { tag, id, cacheHit: true, jarLayerCached: true, notes: [] };
  mkdirSync(join(src.root, '.dev'), { recursive: true });
  const ctx = mkdtempSync(join(src.root, '.dev', 'build-'));
  try {
    const { jar, notes } = buildContext(src, ctx, harnessRoot);
    const labels = { commit: id.commit, tree: id.tree, harness: id.harness, image: id.image, project };
    const args = ['build', '-f', join(ctx, 'Dockerfile'), '--build-arg', `MC_JAR=${jar}`, '-t', tag];
    for (const [k, v] of Object.entries(labels)) args.push('--label', `mc-harness.${k}=${v}`);
    const r = d([...args, ctx]);
    if (r.status !== 0) fail(`docker build failed:\n${(r.stdout + r.stderr).split('\n').slice(-30).join('\n')}`);
    return { tag, id, cacheHit: false, jarLayerCached: stepCached(r.stdout + r.stderr, 'COPY --chown=1000:1000 bin '), notes };
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

// The identity labels of an image or container, as docker inspect reports them.
export function labels(d: Docker, ref: string): Record<string, string> {
  return JSON.parse(must(d, ['inspect', '--format', '{{json .Config.Labels}}', ref])) ?? {};
}
