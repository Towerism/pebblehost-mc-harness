// path-guard: refuse staged changes or a commit range that would add a
// path classify() rejects. Exit 0 clean, 2 refused or error. Never prompts.
import { execFileSync } from 'node:child_process';
import { classify, type Profile } from './paths.ts';

const USAGE = 'usage: path-guard --staged | --range A..B [--profile public|private]';

type Entry = { path: string; blob: string; mode: string };

function die(msg: string): never {
  process.stderr.write(`path-guard: ${msg}\n`);
  process.exit(2);
}

function git(args: string[], input?: string): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    die(`git ${args.join(' ')} failed: ${(e as { stderr?: string }).stderr?.trim() || String(e)}`);
  }
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

// Every path added or modified by any commit in the range, not just the
// net diff: a file added and then removed still lands in the pushed history.
function range(spec: string): Entry[] {
  if (!spec.includes('..')) die(`--range needs A..B, got ${spec}`);
  const commits = git(['rev-list', spec]).split('\n').filter(Boolean);
  return commits.flatMap((c) => parseRaw(git(['diff-tree', '-r', '-m', '-z', '--root', '--no-commit-id', '--no-abbrev', '--no-renames', '--diff-filter=d', c])));
}

const args = process.argv.slice(2);
let profile: Profile = 'public';
let mode: { staged: true } | { range: string } | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--staged') mode = { staged: true };
  else if (a === '--range' && args[i + 1]) mode = { range: args[++i] };
  else if (a === '--profile' && (args[i + 1] === 'public' || args[i + 1] === 'private')) profile = args[++i] as Profile;
  else die(`unexpected argument ${a}\n${USAGE}`);
}
if (!mode) die(USAGE);

const seen = new Map<string, Entry>();
for (const e of 'staged' in mode ? staged() : range(mode.range)) seen.set(`${e.path}\0${e.blob}`, e);
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
for (const e of entries) {
  const reason = classify(e.path, sizes.get(e) ?? 0, profile);
  if (reason && !refused.has(e.path)) refused.set(e.path, reason);
}
if (refused.size > 0) {
  const lines = [...refused].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, r]) => `  ${p}: ${r}`);
  die(`refused ${refused.size} path(s) for the ${profile} repo:\n${lines.join('\n')}\nUnstage or remove them from the commits; see docs/leak-response.md if already pushed.`);
}
