// path-guard: refuse staged changes or commits that would add a path
// classify() rejects, a symlink, or (public) a copy of a local server file.
// Exit 0 clean, 2 refused or error. Never prompts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { classify, MAX_BYTES, type Profile } from './paths.ts';

const USAGE = 'usage: path-guard --staged | --range A..B | --history REV [--profile public|private]';
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
// Local copies of server files, in this checkout and in a superproject.
const SERVER_DIRS = ['server', 'backups', '.mc'];

type Entry = { path: string; blob: string; mode: string };

// A replace ref could show git a clean commit in place of the one pushed.
process.env.GIT_NO_REPLACE_OBJECTS = '1';

function die(msg: string): never {
  process.stderr.write(`path-guard: ${msg}\n`);
  process.exit(2);
}

function run(args: string[], input?: string, env = process.env): string {
  return execFileSync('git', args, { encoding: 'utf8', input, env, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
}

function git(args: string[], input?: string): string {
  try {
    return run(args, input);
  } catch (e) {
    die(`git ${args.join(' ')} failed: ${(e as { stderr?: string }).stderr?.trim() || String(e)}`);
  }
}

// For optional context (work tree, superproject): null when git refuses.
function gitOrNull(args: string[], env = process.env): string | null {
  try {
    return run(args, undefined, env).trim();
  } catch {
    return null;
  }
}

function commit(rev: string): string {
  return gitOrNull(['rev-parse', '--verify', '-q', `${rev}^{commit}`]) || die(`${rev} is not a commit`);
}

// Parse `git diff --raw -z` output: ":old new oldblob newblob status\0path\0".
function parseRaw(out: string): Entry[] {
  const fields = out.split('\0');
  const entries: Entry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].split(' ');
    entries.push({ mode: meta[1], blob: meta[3], path: fields[i + 1] });
  }
  return entries;
}

function staged(): Entry[] {
  return parseRaw(git(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--diff-filter=d']));
}

// Every path added or modified by any commit listed, not just the net diff:
// a file added and then removed still lands in the pushed history.
function commits(revs: string[]): Entry[] {
  const list = git(['rev-list', ...revs]).split('\n').filter(Boolean);
  return list.flatMap((c) => parseRaw(git(['diff-tree', '-r', '-m', '-z', '--root', '--no-commit-id', '--no-abbrev', '--no-renames', '--diff-filter=d', c])));
}

function range(spec: string): Entry[] {
  const m = /^(.+?)\.\.([^.].*)$/.exec(spec);
  if (!m || spec.includes('...')) die(`--range needs A..B, got ${spec}`);
  return commits([`^${commit(m[1])}`, commit(m[2])]);
}

// Blob SHA -> path of every server file this checkout or its superproject
// holds: tracked (index or HEAD) or only on disk. Files over the cap are
// skipped: the cap refuses their copies anyway.
function serverBlobs(): Map<string, string> {
  const blobs = new Map<string, string>();
  const top = gitOrNull(['rev-parse', '--show-toplevel']);
  if (!top) return blobs;
  for (const line of git(['-C', top, 'ls-files', '-s', '-z', '--', ...SERVER_DIRS]).split('\0').filter(Boolean)) {
    const [meta, path] = line.split('\t');
    blobs.set(meta.split(' ')[1], path);
  }
  const roots = [top];
  const sup = gitOrNull(['rev-parse', '--show-superproject-working-tree']);
  if (sup) {
    roots.push(sup);
    // Hooks run with GIT_DIR and GIT_INDEX_FILE set to this repo's.
    const env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[k];
    for (const line of (gitOrNull(['-C', sup, 'ls-tree', '-r', '-z', 'HEAD', '--', 'server/'], env) ?? '').split('\0').filter(Boolean)) {
      const [meta, path] = line.split('\t');
      blobs.set(meta.split(' ')[2], `${sup}/${path}`);
    }
  }
  // Hashed here, not by git hash-object: a running pull adds and removes
  // files while we walk, and a vanished file must not abort the check.
  const dirs = roots.flatMap((root) => SERVER_DIRS.map((d) => join(root, d)));
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    let ents: Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const file = join(dir, ent.name);
      if (ent.isDirectory()) dirs.push(file);
      if (!ent.isFile()) continue;
      let data: Buffer;
      try {
        if (statSync(file).size > MAX_BYTES) continue;
        data = readFileSync(file);
      } catch {
        continue;
      }
      if (data.length === 0 || data.length > MAX_BYTES) continue;
      const sha = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
      blobs.set(sha, file.startsWith(`${top}/`) ? file.slice(top.length + 1) : file);
    }
  }
  blobs.delete(EMPTY_BLOB);
  return blobs;
}

const args = process.argv.slice(2);
let profile: Profile = 'public';
let mode: { staged: true } | { range: string } | { history: string } | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--staged') mode = { staged: true };
  else if (a === '--range' && args[i + 1]) mode = { range: args[++i] };
  else if (a === '--history' && args[i + 1]) mode = { history: args[++i] };
  else if (a === '--profile' && (args[i + 1] === 'public' || args[i + 1] === 'private')) profile = args[++i] as Profile;
  else die(`unexpected argument ${a}\n${USAGE}`);
}
if (!mode) die(USAGE);

const found = 'staged' in mode ? staged() : 'range' in mode ? range(mode.range) : commits([commit(mode.history)]);
const seen = new Map<string, Entry>();
for (const e of found) seen.set(`${e.path}\0${e.blob}`, e);
const entries = [...seen.values()];

// Gitlinks (submodules) point at commits that are not in this repo: size 0.
const blobs = entries.filter((e) => e.mode !== '160000');
const sizes = new Map<Entry, number>();
if (blobs.length > 0) {
  // One output line per input line, in order; a missing object fails closed.
  const out = git(['cat-file', '--batch-check=%(objectsize)'], blobs.map((e) => e.blob).join('\n') + '\n').trim().split('\n');
  blobs.forEach((e, i) => {
    const size = Number(out[i]);
    if (!Number.isInteger(size)) die(`cannot size ${e.path} (${e.blob}): ${out[i]}`);
    sizes.set(e, size);
  });
}

const refused = new Map<string, string>();
const copies = profile === 'public' && blobs.length > 0 ? serverBlobs() : new Map<string, string>();
for (const e of entries) {
  let reason = e.mode === '120000' ? 'symlink' : classify(e.path, sizes.get(e) ?? 0, profile);
  const copy = copies.get(e.blob);
  if (!reason && copy && e.mode !== '160000') reason = `identical to server file ${copy}`;
  if (reason && !refused.has(e.path)) refused.set(e.path, reason);
}
if (refused.size > 0) {
  const lines = [...refused].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, r]) => `  ${p}: ${r}`);
  die(`refused ${refused.size} path(s) for the ${profile} repo:\n${lines.join('\n')}\nUnstage or remove them from the commits; see docs/leak-response.md if already pushed.`);
}
