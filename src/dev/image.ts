// The dev image: built from `git archive <commit> server/` (or, when server/
// is not tracked, a plain copy of it), tagged mc-dev:<imageHash> and labelled
// with the identity a run record reads back from the running container.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fail, must, type Docker } from './docker.ts';
import { applyOverrides } from './overrides.ts';

export const HARNESS_ROOT = resolve(import.meta.dirname, '../..');
// What the harness puts into an image besides the server tree.
export const HARNESS_INPUTS = ['docker/server.Dockerfile', 'docker/entrypoint.sh', 'src/dev/overrides.ts'];
// What goes into the relay image; their hash is its tag.
export const RELAY_INPUTS = ['docker/relay.Dockerfile', 'docker/relay/package.json', 'docker/relay/package-lock.json', 'src/relay/daemon.ts', 'src/relay/client.ts', 'src/relay/rcon.ts', 'src/relay/bots.ts', 'src/relay/egress.ts'];

export type Source = { kind: 'git'; root: string; commit: string } | { kind: 'dir'; root: string };
// source=archive images come from a commit; source=dir images from a plain
// copy, with an empty commit and a tree hash prefixed dir: so it can never
// pass for a git tree. Only archive builds can count for the red/green gate.
export type Identity = { source: 'archive' | 'dir'; commit: string; tree: string; harness: string; image: string };

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// Every harness git call ignores replace refs (git replace), which would make
// a commit's tree read as other bytes.
export function git(root: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, input: opts.input, env: { ...process.env, ...opts.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  return { status: r.status ?? 2, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mustGit(root: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): string {
  const r = git(root, args, opts);
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

// How the extracted files of `<commit>:<prefix>` differ from that tree, one
// line per path: missing, extra, mode, or content. A file whose raw bytes
// differ is hashed again through the repo's clean filters and eol rules
// (--path), which map archive output (LFS smudge, eol=crlf) back to the
// stored blob; export-ignore and export-subst still show as differences.
export function treeDiff(root: string, commit: string, prefix: string, dir: string): string[] {
  const want = new Map<string, { mode: string; blob: string }>();
  for (const e of mustGit(root, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', prefix]).split('\0').filter(Boolean)) {
    const [meta, path] = [e.slice(0, e.indexOf('\t')), e.slice(e.indexOf('\t') + 1)];
    const [mode, , blob] = meta.split(' ');
    want.set(path.slice(prefix.length + 1), { mode, blob });
  }
  const files = walk(dir);
  if (files.some((f) => f.includes('\n'))) fail(`a file name with a newline in ${dir}`);
  const out: string[] = [];
  const have = new Set(files);
  for (const rel of want.keys()) if (!have.has(rel)) out.push(`${rel}: missing`);
  const both = files.filter((f) => {
    if (want.has(f)) return true;
    out.push(`${f}: not in the tree`);
    return false;
  });
  const raw = both.length === 0 ? [] : mustGit(root, ['hash-object', '--no-filters', '--stdin-paths'], { input: `${both.map((f) => join(dir, f)).join('\n')}\n` }).split('\n');
  both.forEach((f, i) => {
    const w = want.get(f) as { mode: string; blob: string };
    const mode = statSync(join(dir, f)).mode & 0o100 ? '100755' : '100644';
    if (mode !== w.mode) out.push(`${f}: mode ${mode}, not ${w.mode}`);
    if (raw[i] !== w.blob && mustGit(root, ['hash-object', `--path=${prefix}/${f}`, join(dir, f)]) !== w.blob) out.push(`${f}: content differs`);
  });
  return out.sort();
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
  return src.kind === 'git' ? mustGit(src.root, ['rev-parse', `${src.commit}:server`]) : `dir:${dirHash(join(src.root, 'server'))}`;
}

// The code that runs checks and judges them (bin/check run, the check APIs,
// the gate): its hash is recorded with every run as toolHash.
export const CHECK_DIRS = ['src/check', 'src/gate'];

// Uncommitted changes to the harness's image, relay or check code, as `git
// status --porcelain` lines: a pod or a run from them would not be what any
// commit holds, and the recorded hashes would name code nobody can check out.
export function dirtyHarness(harnessRoot = HARNESS_ROOT): string[] {
  const r = git(harnessRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...HARNESS_INPUTS, ...RELAY_INPUTS, ...CHECK_DIRS]);
  if (r.status !== 0) fail(`cannot check the harness at ${harnessRoot} for uncommitted changes: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

export function harnessHash(harnessRoot = HARNESS_ROOT): string {
  const h = createHash('sha256');
  for (const f of HARNESS_INPUTS) h.update(`${f}\n${sha256(readFileSync(join(harnessRoot, f)))}\n`);
  return h.digest('hex');
}

// Over the tracked files only: an ignored scratch file must not change it.
export function toolHash(harnessRoot = HARNESS_ROOT): string {
  const h = createHash('sha256');
  for (const f of mustGit(harnessRoot, ['ls-files', '-z', '--', ...CHECK_DIRS]).split('\0').filter(Boolean).sort()) h.update(`${f}\n${sha256(readFileSync(join(harnessRoot, f)))}\n`);
  return h.digest('hex');
}

export function identity(src: Source, harnessRoot = HARNESS_ROOT): Identity {
  const tree = treeHash(src);
  const harness = harnessHash(harnessRoot);
  const git = src.kind === 'git';
  return { source: git ? 'archive' : 'dir', commit: git ? src.commit : '', tree, harness, image: sha256(`${tree}\n${harness}`) };
}

// Big, rarely changing files go to the first layer so a config-only change
// reuses it.
function isBin(rel: string): boolean {
  const top = rel.split('/')[0];
  return ['libraries', 'versions', 'cache'].includes(top) || rel.toLowerCase().endsWith('.jar');
}

// The *.jar files at the server root, sorted.
export function rootJars(src: Source): string[] {
  const names = src.kind === 'git' ? mustGit(src.root, ['ls-tree', '--name-only', src.commit, 'server/']).split('\n').map((p) => p.slice('server/'.length)) : readdirSync(join(src.root, 'server'));
  return names.filter((f) => f.toLowerCase().endsWith('.jar')).sort();
}

// Which root jar the server runs: `wanted` (bin/dev --jar), else the only
// one. Hosts like PebbleHost pick the jar outside the files, so a tree with
// several needs --jar.
export function chooseJar(src: Source, wanted?: string): string {
  const jars = rootJars(src);
  if (wanted !== undefined) {
    if (!jars.includes(wanted)) fail(`--jar ${wanted} is not a jar at the server/ root (found: ${jars.join(', ') || 'none'})`);
    return wanted;
  }
  if (jars.length !== 1) fail(`server/ has ${jars.length ? `${jars.length} root jars (${jars.join(', ')}); pick one with --jar NAME` : 'no *.jar at its root'}`);
  return jars[0];
}

// Lay out ctx/{bin,cfg,ovr} plus the Dockerfile and entrypoint.
export function buildContext(src: Source, ctx: string, harnessRoot = HARNESS_ROOT): { notes: string[] } {
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
    // git archive applies export-ignore and export-subst from .gitattributes
    // and .git/info/attributes: the extracted files must still be the tree.
    const diff = treeDiff(src.root, src.commit, 'server', base);
    if (diff.length > 0) fail(`git archive of server/ at ${src.commit.slice(0, 12)} is not its tree (export-ignore or export-subst in .gitattributes or .git/info/attributes?):\n${diff.slice(0, 20).join('\n')}${diff.length > 20 ? `\n... ${diff.length - 20} more` : ''}`);
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
    notes.push(...a.notes);
    if (a.content === null || a.set === 0) continue;
    const ovr = join(ctx, 'ovr', a.file);
    mkdirSync(dirname(ovr), { recursive: true });
    writeFileSync(ovr, a.content);
    // The classic builder drops a later-layer file whose size and mtime
    // second match the earlier layer's copy; an edit can keep the size.
    const mtime = statSync(join(ctx, 'cfg', a.file)).mtimeMs / 1000 + 2;
    utimesSync(ovr, mtime, mtime);
  }
  cpSync(join(harnessRoot, 'docker/server.Dockerfile'), join(ctx, 'Dockerfile'));
  cpSync(join(harnessRoot, 'docker/entrypoint.sh'), join(ctx, 'entrypoint.sh'));
  return { notes };
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

// The tag carries the project: two checkouts with the same server tree would
// otherwise share one tag, and a build in one would retag (and relabel, with
// its own commit) the image the other is about to run.
export function build(src: Source, d: Docker, project: string, harnessRoot = HARNESS_ROOT): Built {
  const id = identity(src, harnessRoot);
  const tag = `mc-dev:${project}-${id.image}`;
  if (d(['image', 'inspect', tag]).status === 0) return { tag, id, cacheHit: true, jarLayerCached: true, notes: [] };
  const ctx = mkdtempSync(join(privateDir(join(src.root, '.dev')), 'build-'));
  try {
    const { notes } = buildContext(src, ctx, harnessRoot);
    const labels = { source: id.source, commit: id.commit, tree: id.tree, harness: id.harness, image: id.image, project };
    const args = ['build', '-f', join(ctx, 'Dockerfile'), '-t', tag];
    for (const [k, v] of Object.entries(labels)) args.push('--label', `mc-harness.${k}=${v}`);
    const r = d([...args, ctx]);
    if (r.status !== 0) fail(`docker build failed:\n${(r.stdout + r.stderr).split('\n').slice(-30).join('\n')}`);
    const checked = verifyOverrides(d, tag, join(ctx, 'ovr'));
    return { tag, id, cacheHit: false, jarLayerCached: stepCached(r.stdout + r.stderr, 'COPY --chown=1000:1000 bin '), notes: [...notes, `${checked} overridden file(s) verified in the image`] };
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

// The relay image, mc-relay:<project>-<hash of RELAY_INPUTS>, built once per
// change to them. It holds no server files; the project keeps each
// checkout's down --all and prune to its own image.
export function buildRelay(d: Docker, project: string, root: string, harnessRoot = HARNESS_ROOT): string {
  const h = createHash('sha256');
  for (const f of RELAY_INPUTS) h.update(`${f}\n${sha256(readFileSync(join(harnessRoot, f)))}\n`);
  const tag = `mc-relay:${project}-${h.digest('hex')}`;
  if (d(['image', 'inspect', tag]).status === 0) return tag;
  const ctx = mkdtempSync(join(privateDir(join(root, '.dev')), 'relay-'));
  try {
    // deps/: what npm ci installs (docker/relay/); relay/: the daemon's sources.
    for (const f of RELAY_INPUTS) {
      const dest = f === 'docker/relay.Dockerfile' ? 'Dockerfile' : f.startsWith('docker/relay/') ? `deps/${f.slice('docker/relay/'.length)}` : `relay/${f.slice('src/relay/'.length)}`;
      mkdirSync(dirname(join(ctx, dest)), { recursive: true });
      cpSync(join(harnessRoot, f), join(ctx, dest));
    }
    writeFileSync(join(ctx, 'relay', 'package.json'), '{"type":"module"}\n');
    const r = d(['build', '-f', join(ctx, 'Dockerfile'), '-t', tag, '--label', `mc-harness.project=${project}`, ctx]);
    if (r.status !== 0) fail(`docker build of the relay failed:\n${(r.stdout + r.stderr).split('\n').slice(-30).join('\n')}`);
    return tag;
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

// Every file in the context's ovr/ must be byte-equal in the built image;
// otherwise the image is removed and the build fails. Returns the count.
export function verifyOverrides(d: Docker, tag: string, ovr: string): number {
  const files = walk(ovr);
  if (files.length === 0) return 0;
  const r = d(['run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', tag, ...files.map((f) => `/server/${f}`)]);
  const got = new Map(r.stdout.split('\n').filter(Boolean).map((l) => [l.slice(66), l.slice(0, 64)] as [string, string]));
  const bad = files.filter((f) => got.get(`/server/${f}`) !== sha256(readFileSync(join(ovr, f))));
  if (r.status !== 0 || bad.length > 0) {
    d(['image', 'rm', '-f', tag]);
    fail(`the built image lacks overridden file(s): ${bad.join(', ') || r.stderr.trim()}; image removed`);
  }
  return files.length;
}

// .dev/ holds merged fixtures and build contexts, which can carry server
// secrets: owner-only.
export function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

// Remove the project's mc-dev and mc-relay images except `keep` and those a
// container still uses: mc-dev ones hold server configs and secrets. Returns
// how many went.
export function pruneImages(d: Docker, project: string, keep: string[]): number {
  const used = new Set(must(d, ['ps', '-a', '--filter', `label=mc-harness.project=${project}`, '--format', '{{.Image}}']).split('\n').filter(Boolean));
  const imgs = must(d, ['image', 'ls', '--filter', `label=mc-harness.project=${project}`, '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']).split('\n').filter(Boolean);
  const gone = imgs.filter((l) => {
    const [ref, id] = l.split(' ');
    return /^mc-(dev|relay):/.test(ref) && !keep.includes(ref) && !used.has(ref) && !used.has(id);
  });
  if (gone.length > 0) must(d, ['image', 'rm', '-f', ...gone.map((l) => l.split(' ')[0])]);
  return gone.length;
}

// The identity labels of an image or container, as docker inspect reports them.
export function labels(d: Docker, ref: string): Record<string, string> {
  return JSON.parse(must(d, ['inspect', '--format', '{{json .Config.Labels}}', ref])) ?? {};
}
