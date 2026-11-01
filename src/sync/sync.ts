// bin/dev sync, seed and inventory: main mirrors live. sync runs in a
// persistent worktree of main at .dev/sync (MC_HOME there, MC_ENV_FILE the
// project's .env, which only bin/mc reads), pulls the tracked roots minus the
// sync-rules skip and data paths, and commits "live drift: <n> files" on main
// only when something changed. seed N syncs, puts the project on issue/N and
// boots a fresh pod with opt-in data pulled as fixtures. inventory proposes
// data rules from files live rewrites between two listings.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from '../dev/docker.ts';
import { git, HARNESS_ROOT, privateDir } from '../dev/image.ts';
import { readRules, rcloneExcludes, matchRule, writeGitignore, DEFAULT_RULES, type Rule, type RuleClass } from './rules.ts';

// The server paths main tracks, besides the jars at the root.
export const SYNC_ROOTS = ['server.properties', 'bukkit.yml', 'spigot.yml', 'eula.txt', 'start.sh', 'config', 'plugins', 'libraries', 'versions', 'cache'];

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
export function mc(home: string, root: string, args: string[], exclude?: string, extra: Record<string, string> = {}): { status: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, MC_HOME: home, MC_ENV_FILE: envFile(root), RCLONE_RETRIES: '1', MC_EXCLUDE_FILE: exclude, ...extra };
  if (!exclude) delete env.MC_EXCLUDE_FILE;
  const r = spawnSync(join(HARNESS_ROOT, 'bin/mc'), args, { encoding: 'utf8', env, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 2, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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
  if (r.status !== 0) {
    const changed = r.out.split('\n').filter((l) => /changed|updated|size changed|corrupted/i.test(l));
    fail(`pull of ${path} failed${changed.length ? `; live rewrote files during the copy:\n${changed.join('\n')}\nrun it again` : `:\n${r.out.trim()}`}`);
  }
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

export type SyncResult = { drift: number; commits: string[] };

export function syncLive(root: string): SyncResult {
  const wt = worktree(root);
  const rules = readRules(wt);
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
  mustGit(wt, ['add', '-A', '--', 'server']);
  const staged = mustGit(wt, ['diff', '--cached', '--name-only', '--', 'server']).split('\n').filter(Boolean);
  if (staged.length === 0) {
    say('sync: no live drift');
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
  return { drift: staged.length, commits };
}

export type SeedOpts = { withData: string[]; withWorlds: boolean };

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
  return paths.length > 0 ? [join(home, 'server')] : [];
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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitS * 1000);
  const second = list();
  const changed = [...new Set([...first.keys(), ...second.keys()])].filter((p) => first.get(p) !== second.get(p)).sort();
  const named = [...new Set([...second.keys()].flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].filter((d) => /(^|\/)[^/]*data$/i.test(d)).map((d) => `${d}/`);
  const proposals = [...changed, ...named].filter((p) => !matchRule(rules, p.replace(/\/$/, ''), ['skip', 'data', 'review']));
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

