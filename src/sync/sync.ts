// bin/dev sync, seed and inventory: main mirrors live. sync runs in a
// persistent worktree of main at .dev/sync (MC_HOME there, MC_ENV_FILE the
// project's .env, which only bin/mc reads), pulls the tracked roots minus the
// sync-rules skip and data paths, and commits "live drift: <n> files" on main
// only when something changed. After the first sync it pulls only what changed
// since the listing stored in .dev/sync-listing.json. seed N syncs, puts the
// project on issue/N and boots a fresh pod with opt-in data pulled as
// fixtures. inventory proposes data rules from files live rewrites between
// two listings.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fail } from '../dev/docker.ts';
import { git, HARNESS_ROOT, privateDir } from '../dev/image.ts';
import { readRules, rcloneExcludes, matchRule, writeGitignore, DEFAULT_RULES, type Rule, type RuleClass } from './rules.ts';

// The server paths main tracks, besides the jars at the root.
export const SYNC_ROOTS = ['server.properties', 'bukkit.yml', 'spigot.yml', 'eula.txt', 'start.sh', 'config', 'plugins', 'libraries', 'versions', 'cache'];
// Purpur updates and plugin library downloads rewrite these: listed again
// only when a root or plugins/ jar changed, the rules changed, or with --full.
const JAR_ROOTS = ['libraries', 'versions', 'cache'];
// An incremental sync with no changed files should finish within this.
const BUDGET_S = 30;
// SFTP modtimes have 1-second precision, and live's clock may be off from
// this machine's: a file dated this close to the last listing may have been
// rewritten since in the same second, size unchanged.
const WINDOW_S = 120;

const say = (msg: string) => process.stdout.write(`${msg}\n`);

function mustGit(dir: string, args: string[]): string {
  const r = git(dir, args);
  if (r.status !== 0) fail(`git ${args.join(' ')} failed in ${dir}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

const commit = (dir: string, msg: string) => mustGit(dir, ['commit', '-q', '-m', msg]);

export function envFile(root: string): string {
  return process.env.MC_ENV_FILE || join(root, '.env');
}

// bin/mc with its own MC_HOME and the project's .env; one rclone retry, so a
// file live rewrites mid-copy fails the pull instead of re-downloading it all.
export function mc(home: string, root: string, args: string[], exclude?: string, extra: Record<string, string> = {}, input?: string): { status: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, MC_HOME: home, MC_ENV_FILE: envFile(root), RCLONE_RETRIES: '1', MC_EXCLUDE_FILE: exclude, ...extra };
  if (!exclude) delete env.MC_EXCLUDE_FILE;
  if (!extra.MC_FILTER_FILE) delete env.MC_FILTER_FILE;
  const r = spawnSync(join(HARNESS_ROOT, 'bin/mc'), args, { encoding: 'utf8', env, input, maxBuffer: 1 << 28, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  return { status: r.status ?? 2, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// A failed transfer: rclone's lines naming files live rewrote mid-copy, or
// its whole output.
function transferFailed(what: string, out: string): never {
  const changed = out.split('\n').filter((l) => /changed|updated|size changed|corrupted/i.test(l));
  fail(`${what} failed${changed.length ? `; live rewrote files during the copy:\n${changed.join('\n')}\nrun it again` : `:\n${out.trim()}`}`);
}

// Pull one server path into home/server with the rules of `classes` excluded.
// rclone takes no filters on a single file: a file a rule covers is left out
// here instead.
function pull(home: string, root: string, path: string, rules: Rule[], classes: RuleClass[], dir: boolean): void {
  let ex: string | undefined;
  if (dir) {
    ex = join(home, '.mc-exclude');
    writeFileSync(ex, rcloneExcludes(rules, classes, path));
  } else if (matchRule(rules, path, classes)) {
    say(`sync-rules ${matchRule(rules, path, classes)?.cls} ${matchRule(rules, path, classes)?.pattern}: ${path} not pulled`);
    return;
  }
  const r = mc(home, root, ['pull', path], ex);
  if (r.status !== 0) transferFailed(`pull of ${path}`, r.out);
}

export function syncDir(root: string): string {
  return join(root, '.dev', 'sync');
}

// The persistent worktree of main; refused when it is on another branch.
function worktree(root: string): string {
  const wt = syncDir(root);
  if (!existsSync(join(wt, '.git'))) {
    if (git(root, ['rev-parse', '--verify', '-q', 'refs/heads/main']).status !== 0) fail('no main branch to sync');
    const cur = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
    if (cur === 'main') fail(`main is checked out in ${root}; sync keeps main in .dev/sync: switch the project to another branch (bin/dev seed N puts it on issue/N)`);
    privateDir(join(root, '.dev'));
    mustGit(root, ['worktree', 'add', '-q', wt, 'main']);
  }
  const branch = git(wt, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
  if (branch !== 'main') fail(`.dev/sync is on ${branch || 'a detached HEAD'}, not main; sync commits only to main`);
  // The worktree belongs to sync: leftovers of an interrupted run go.
  mustGit(wt, ['reset', '-q', '--hard']);
  mustGit(wt, ['clean', '-q', '-f', '-d', '-x', '--', 'server']);
  return wt;
}

// A live file's size and modtime (UTC, 1-second precision) as listed.
export type Entry = { size: number; time: string };
export type Listing = Record<string, Entry>;
// What the last sync saw: its listing, when that listing started and where
// its window starts (epoch s), the server/ tree it left on main, and the
// hash of the skip and data rules it listed with.
type Stored = { start: number; since?: number; tree: string; rules?: string; files: Listing };

const listingFile = (root: string) => join(root, '.dev', 'sync-listing.json');
const epoch = (time: string) => Date.parse(`${time.replace(' ', 'T')}Z`) / 1000;

// bin/mc ls -R -l lines: size, modtime, then the name after two spaces.
export function parseListing(out: string): Listing {
  const files: Listing = {};
  for (const line of out.split('\n')) {
    const m = /^ *(\d+) {2}(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) {2}(.+)$/.exec(line);
    if (m) files[m[3]] = { size: Number(m[1]), time: m[2] };
  }
  return files;
}

// The window of a listing: WINDOW_S before its start or the newest live
// mtime in it, whichever is earlier (live's clock may lag this machine's).
export function windowStart(start: number, files: Listing): number {
  const newest = Object.values(files).reduce((n, e) => Math.max(n, epoch(e.time)), -Infinity);
  return (newest === -Infinity ? start : Math.min(start, newest)) - WINDOW_S;
}

// Files to download (new, resized or re-dated), unchanged files dated inside
// the previous listing's window (`since`) to fetch again, and files gone from
// live.
export function diffListing(prev: Listing, next: Listing, since: number): { fetch: string[]; recheck: string[]; remove: string[] } {
  const fetch: string[] = [];
  const recheck: string[] = [];
  for (const p of Object.keys(next)) {
    const a = Object.hasOwn(prev, p) ? prev[p] : undefined;
    if (!a || a.size !== next[p].size || a.time !== next[p].time) fetch.push(p);
    else if (epoch(next[p].time) >= since) recheck.push(p);
  }
  const remove = Object.keys(prev).filter((p) => !Object.hasOwn(next, p));
  return { fetch: fetch.sort(), recheck: recheck.sort(), remove: remove.sort() };
}

export function timing(seconds: number, incremental: boolean, downloaded: number): string {
  const line = `sync: done in ${seconds.toFixed(1)}s`;
  return incremental && downloaded === 0 && seconds > BUDGET_S ? `${line}\nsync: OVER BUDGET: an incremental sync with no changed files took over ${BUDGET_S}s` : line;
}

function checkers(): string {
  const n = process.env.MC_SYNC_CHECKERS || '16';
  if (!/^[1-9]\d*$/.test(n)) fail(`MC_SYNC_CHECKERS must be a positive integer, got "${n}"`);
  return n;
}

// One recursive listing of the given roots (root jars too with `jars`),
// minus skip and data paths. One call at a time: live's SFTP refuses
// connections past a few concurrent listers.
function listLive(wt: string, root: string, rules: Rule[], roots: string[], jars: boolean): Listing {
  const f = join(wt, '.mc-filter');
  const ex = rcloneExcludes(rules, ['skip', 'data']).split('\n').filter(Boolean).map((l) => `- ${l}`);
  const inc = [...roots.flatMap((r) => [`+ /${r}`, `+ /${r}/**`]), ...(jars ? ['+ /*.[jJ][aA][rR]'] : [])];
  writeFileSync(f, `${[...ex, ...inc, '- **'].join('\n')}\n`);
  const r = mc(wt, root, ['ls', '-R', '-l'], undefined, { MC_FILTER_FILE: f, RCLONE_CHECKERS: checkers() });
  rmSync(f, { force: true });
  if (r.status !== 0) fail(`listing live failed:\n${r.out.trim()}`);
  const files = parseListing(r.out);
  // rclone's filters match case; the rules don't.
  for (const p of Object.keys(files)) if (matchRule(rules, p)) delete files[p];
  return files;
}

const underJarRoots = (p: string) => JAR_ROOTS.some((r) => p.startsWith(`${r}/`));
// Root jars and top-level plugins/*.jar: a change to any may rewrite the jar roots.
export const jarKey = (files: Listing) =>
  Object.keys(files)
    .filter((p) => /^(plugins\/)?[^/]+\.jar$/i.test(p))
    .sort()
    .map((p) => `${p} ${files[p].size} ${files[p].time}`)
    .join('\n');

function readStored(root: string): Stored | undefined {
  try {
    return JSON.parse(readFileSync(listingFile(root), 'utf8')) as Stored;
  } catch {
    return undefined;
  }
}

const rulesKey = (rules: Rule[]) =>
  createHash('sha256')
    .update(rules.filter((r) => r.cls !== 'review').map((r) => `${r.cls} ${r.pattern}`).join('\n'))
    .digest('hex');

// Empty directories from `dir` up to (not including) `top`.
function prune(dir: string, top: string): void {
  for (let d = dir; d.startsWith(`${top}/`) && existsSync(d) && readdirSync(d).length === 0; d = dirname(d)) rmdirSync(d);
}

const serverTree = (wt: string) => git(wt, ['rev-parse', '-q', '--verify', 'HEAD:server']).stdout.trim();

export type SyncResult = { drift: number; commits: string[] };

export function syncLive(root: string, full = false): SyncResult {
  const t0 = Date.now();
  const wt = worktree(root);
  const rules = readRules(wt);
  const stored = readStored(root);
  // The stored listing describes main's server/ only if nothing else changed it.
  const why = full ? '--full' : !stored ? 'no stored listing' : stored.tree !== serverTree(wt) ? "main's server/ changed since the stored listing" : '';
  const commits: string[] = [];
  // Tracked files a skip or data rule now covers leave the index first.
  const tracked = mustGit(wt, ['ls-files', '-z', '--', 'server']).split('\0').filter(Boolean);
  const byRule = new Map<Rule, string[]>();
  for (const f of tracked) {
    const r = matchRule(rules, f.slice('server/'.length));
    if (r) byRule.set(r, [...(byRule.get(r) ?? []), f]);
  }
  for (const [r, files] of byRule) {
    mustGit(wt, ['rm', '-q', '--cached', '--', ...files]);
    const msg = `chore: untrack ${r.cls === 'data' ? 'plugin data' : 'skipped paths'} (${r.pattern})`;
    commit(wt, msg);
    commits.push(msg);
  }
  if (writeGitignore(join(wt, '.gitignore'), rules)) {
    mustGit(wt, ['add', '.gitignore']);
    commit(wt, 'chore: regenerate the sync-rules section of .gitignore');
    commits.push('chore: regenerate the sync-rules section of .gitignore');
  }
  const start = Date.now() / 1000;
  const listed = listLive(wt, root, rules, SYNC_ROOTS.filter((r) => !JAR_ROOTS.includes(r)), true);
  const ruleHash = rulesKey(rules);
  const relist = why ? 'full' : !stored ? 'full' : jarKey(stored.files) !== jarKey(listed) ? 'a root or plugins/ jar changed' : stored.rules !== ruleHash ? 'sync-rules changed' : '';
  // Kept entries go through the rules too: a rule may have changed since.
  const kept = stored ? Object.fromEntries(Object.entries(stored.files).filter(([p]) => underJarRoots(p) && !matchRule(rules, p))) : {};
  const files = { ...listed, ...(relist ? listLive(wt, root, rules, JAR_ROOTS, false) : kept) };
  let fetched = 0;
  if (why) {
    say(`sync: full pull (${why})`);
    fullPull(wt, root, rules);
  } else if (stored) {
    say(`sync: ${JAR_ROOTS.join(', ')}: ${relist ? `listed again (${relist})` : 'kept the last listing (no jar or sync-rules change)'}`);
    if (Object.keys(files).length === 0) fail('live has none of the tracked roots; is MC_ENV_FILE the right server?');
    // Unlisted roots keep their stored entries: diff only what was listed.
    const prev = relist ? stored.files : Object.fromEntries(Object.entries(stored.files).filter(([p]) => !underJarRoots(p)));
    const { fetch, recheck, remove } = diffListing(prev, relist ? files : listed, stored.since ?? windowStart(stored.start, stored.files));
    const server = join(wt, 'server');
    // Removals first, pruning what they empty: a directory live replaced by
    // a file must be gone before the file comes down.
    for (const p of remove) {
      rmSync(join(server, p), { force: true });
      prune(dirname(join(server, p)), server);
    }
    const get = [...fetch, ...recheck];
    if (get.length > 0) {
      const r = mc(wt, root, ['fetch'], undefined, {}, `${get.join('\n')}\n`);
      if (r.status !== 0) transferFailed(`download of ${get.length} files`, r.out);
    }
    fetched = fetch.length;
    say(`sync: downloaded ${fetch.length} changed files, removed ${remove.length}; re-fetched ${recheck.length} in the window`);
  }
  // Written only once main holds what the listing describes.
  const done = () => {
    const stored: Stored = { start, since: windowStart(start, files), tree: serverTree(wt), rules: ruleHash, files };
    writeFileSync(listingFile(root), JSON.stringify(stored), { mode: 0o600 });
    say(timing((Date.now() - t0) / 1000, !why, fetched));
  };
  mustGit(wt, ['add', '-A', '--', 'server']);
  const staged = mustGit(wt, ['diff', '--cached', '--name-only', '--', 'server']).split('\n').filter(Boolean);
  if (staged.length === 0) {
    say('sync: no live drift');
    done();
    return { drift: 0, commits };
  }
  const guard = spawnSync(join(HARNESS_ROOT, 'bin/path-guard'), ['--staged', '--profile', 'private'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (guard.status !== 0) {
    mustGit(wt, ['reset', '-q', '--hard']);
    fail(`the private guard refused the drift; nothing committed (add sync-rules for these paths):\n${(guard.stderr || guard.stdout).trim()}`);
  }
  const msg = `live drift: ${staged.length} files`;
  commit(wt, msg);
  commits.push(msg);
  say(`sync: committed "${msg}" on main`);
  done();
  return { drift: staged.length, commits };
}

// Today's full re-pull: every tracked root live has, replaced whole. rclone's
// excludes match case and the rules don't: what they let through goes after.
function fullPull(wt: string, root: string, rules: Rule[]): void {
  const ls = mc(wt, root, ['ls']);
  if (ls.status !== 0) fail(`bin/mc ls failed:\n${ls.out.trim()}`);
  const names = ls.out.split('\n').map((l) => l.trim()).filter(Boolean);
  const present = new Set(names.map((n) => n.replace(/\/$/, '')));
  const roots = [...SYNC_ROOTS.filter((r) => present.has(r)), ...names.filter((n) => n.toLowerCase().endsWith('.jar'))];
  const dirs = new Set(names.filter((n) => n.endsWith('/')).map((n) => n.slice(0, -1)));
  if (roots.length === 0) fail('live has none of the tracked roots; is MC_ENV_FILE the right server?');
  for (const r of roots) {
    // Tracked content is in git; removing it first keeps bin/mc from taking it for unpushed edits.
    rmSync(join(wt, 'server', r), { recursive: true, force: true });
    pull(wt, root, r, rules, ['skip', 'data'], dirs.has(r));
    say(`sync: pulled ${r}`);
  }
  const server = join(wt, 'server');
  for (const e of existsSync(server) ? readdirSync(server, { recursive: true, withFileTypes: true }) : []) {
    if (e.isFile() && matchRule(rules, relative(server, join(e.parentPath, e.name)))) rmSync(join(e.parentPath, e.name));
  }
}

export type SeedOpts = { withData: string[]; withWorlds: boolean };

// --with-data paths a skip rule covers: refused before anything else runs.
export function refuseSkipped(root: string, paths: string[]): void {
  const rules = readRules(syncDir(root));
  for (const p of paths) {
    const skip = matchRule(rules, p, ['skip']) ?? matchRule(rules, p, ['skip'], true);
    if (skip) fail(`--with-data ${p}: sync-rules skip ${skip.pattern} covers it; skip paths are never transferred`);
  }
}

// The seed's data fixtures: .dev/seed-N/home/server after the opt-in pulls,
// or none.
export function seedData(root: string, n: number, o: SeedOpts): string[] {
  const dir = join(root, '.dev', `seed-${n}`);
  rmSync(dir, { recursive: true, force: true });
  const home = join(privateDir(dir), 'home');
  mkdirSync(home, { recursive: true });
  const rules = readRules(syncDir(root));
  const paths = [...o.withData];
  const dirs = new Set<string>();
  if (o.withWorlds) {
    const ls = mc(home, root, ['ls']);
    if (ls.status !== 0) fail(`bin/mc ls failed:\n${ls.out.trim()}`);
    const worlds = ls.out.split('\n').map((l) => l.trim()).filter((l) => /^world[^/]*\/$/.test(l)).map((l) => l.slice(0, -1));
    paths.push(...worlds);
    for (const w of worlds) dirs.add(w);
  }
  refuseSkipped(root, o.withData);
  for (const p of o.withData) {
    // A path is a directory when listing it shows more than the path itself.
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const ls = mc(home, root, ['ls', parent]);
    if (ls.status !== 0) fail(`bin/mc ls ${parent || '.'} failed:\n${ls.out.trim()}`);
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (ls.out.split('\n').includes(`${name}/`)) dirs.add(p);
    else if (!ls.out.split('\n').includes(name)) fail(`--with-data ${p}: not on live`);
  }
  for (const p of paths) {
    // Data comes in; skip paths still stay out.
    pull(home, root, p, rules, ['skip'], dirs.has(p));
    say(`seed: pulled ${p} as data`);
  }
  // Fixtures only when something arrived: an empty directory, or one whose
  // files skip rules all left out, boots with none.
  const data = join(home, 'server');
  if (paths.length > 0 && !(existsSync(data) && readdirSync(data, { recursive: true, withFileTypes: true }).some((e) => e.isFile()))) {
    say('seed: the data paths held no files to pull; booting with no data fixtures');
    return [];
  }
  return paths.length > 0 ? [data] : [];
}

// Put the project on issue/N: reuse it (keeping its commits) or cut it from
// main after the sync. Refuses uncommitted work.
export function issueBranch(root: string, n: number, sync: () => void): 'reused' | 'created' {
  const dirty = mustGit(root, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) fail(`the project has uncommitted changes; commit or stash them first:\n${dirty}`);
  const name = `issue/${n}`;
  const exists = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).status === 0;
  const cur = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
  if (cur !== name) mustGit(root, exists ? ['switch', '-q', name] : ['switch', '-q', '-c', name, 'main']);
  sync();
  if (!exists) mustGit(root, ['merge', '-q', '--ff-only', 'main']);
  return exists ? 'reused' : 'created';
}

// Files live rewrote between two listings `waitS` apart, and data-looking
// directory names, as review entries in main's sync-rules (committed).
export function inventory(root: string, waitS: number, dirs = ['plugins']): string[] {
  const wt = worktree(root);
  const rules = readRules(wt);
  const list = () => {
    const out = new Map<string, string>();
    for (const d of dirs) {
      const ex = join(wt, '.mc-exclude');
      writeFileSync(ex, rcloneExcludes(rules, ['skip'], d));
      const r = mc(wt, root, ['ls', '-R', '-l', d], ex);
      if (r.status !== 0) fail(`bin/mc ls -R ${d} failed:\n${r.out.trim()}`);
      for (const line of r.out.split('\n')) {
        const m = /^\s*(\S+)\s+(\S+ \S+)\s+(.+)$/.exec(line);
        if (m) out.set(`${d}/${m[3]}`, `${m[1]} ${m[2]}`);
      }
    }
    return out;
  };
  const first = list();
  say(`inventory: listed ${first.size} file(s); listing again in ${waitS}s`);
  spawnSync('sleep', [String(waitS)], { stdio: 'ignore' });
  const second = list();
  const changed = [...new Set([...first.keys(), ...second.keys()])].filter((p) => first.get(p) !== second.get(p)).sort();
  const named = [...new Set([...second.keys()].flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].filter((d) => /(^|\/)[^/]*data$/i.test(d)).map((d) => `${d}/`);
  const proposals = [...changed, ...named].filter((p) => !matchRule(rules, p.replace(/\/$/, ''), ['skip', 'data', 'review'], p.endsWith('/')));
  if (proposals.length === 0) {
    say('inventory: nothing new to review');
    return [];
  }
  const file = join(wt, 'sync-rules');
  const base = existsSync(file) ? readFileSync(file, 'utf8') : readFileSync(DEFAULT_RULES, 'utf8');
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(file, `${base}${base.endsWith('\n') ? '' : '\n'}\n# bin/dev inventory ${stamp}: make each skip or data, or delete it.\n${proposals.map((p) => `review ${p}`).join('\n')}\n`);
  mustGit(wt, ['add', 'sync-rules']);
  commit(wt, `chore: sync-rules review entries from inventory (${proposals.length})`);
  for (const p of proposals) say(`review ${p}${changed.includes(p) ? '  (changed between the listings)' : '  (data-like name)'}`);
  return proposals;
}

