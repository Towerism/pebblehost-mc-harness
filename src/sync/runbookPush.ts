// bin/check runbook push N and rollback N: put issue/N's server/ changes on
// live, guarded. The push set is the server/** paths of main...issue/N with
// the prefix stripped; every other path is "not pushed", and a deleted file
// is a manual step (bin/mc never deletes). Before anything is written, each
// file is pulled into the persistent .dev/runbook-N/home and must still be
// main's version: drift on main or on live since issue/N was cut refuses the
// push. Then each one goes up with MC_RUNBOOK=1 (bin/mc refuses a bare push
// in the private repo), is journalled in .dev/runbook-N/journal.jsonl with
// its backup, and the run stops at the first failure.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fail } from '../dev/docker.ts';
import { git, HARNESS_ROOT, privateDir } from '../dev/image.ts';
import { envFile, mc } from './sync.ts';

const say = (msg: string) => process.stdout.write(`${msg}\n`);

function mustGit(root: string, args: string[]): string {
  const r = git(root, args);
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export type PushSet = { changed: string[]; added: string[]; deleted: string[]; notPushed: string[] };

// What main...issue/N changes: server/ files to push (changed or added),
// deleted server/ files, and the paths outside server/.
export function pushSet(root: string, n: number): PushSet {
  for (const b of ['main', `issue/${n}`]) if (git(root, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).status !== 0) fail(`no ${b} branch`);
  const set: PushSet = { changed: [], added: [], deleted: [], notPushed: [] };
  const out = mustGit(root, ['diff', '--name-status', '--no-renames', '-z', `main...issue/${n}`]).split('\0').filter(Boolean);
  for (let i = 0; i < out.length; i += 2) {
    const [status, path] = [out[i], out[i + 1]];
    if (!path.startsWith('server/')) set.notPushed.push(path);
    else if (status === 'D') set.deleted.push(path.slice('server/'.length));
    else (status === 'A' ? set.added : set.changed).push(path.slice('server/'.length));
  }
  return set;
}

// Paths of the set that main changed after issue/N was cut (synced drift).
export function mainDrift(root: string, n: number, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const base = mustGit(root, ['merge-base', 'main', `issue/${n}`]);
  return mustGit(root, ['diff', '--name-only', '--no-renames', '-z', base, 'main', '--', ...paths.map((p) => `:(literal)server/${p}`)]).split('\0').filter(Boolean).map((p) => p.slice('server/'.length));
}

function blob(root: string, rev: string, path: string): Buffer {
  const r = spawnSync('git', ['-C', root, 'cat-file', 'blob', `${rev}:server/${path}`], { maxBuffer: 1 << 30, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  if (r.status !== 0) fail(`git cat-file ${rev}:server/${path} failed: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

// One bin/mc transfer: a changed file on its own, or the deepest directory
// live already has for added files, with every other entry there excluded
// so only the new paths move.
type Unit = { transfer: string; files: string[]; added: boolean; exclude?: string };

export type Journal = { run: string; time: string; issue: number; transfer: string; files: string[]; added: boolean; status: 'ok' | 'failed'; backup?: string; error?: string };

const runDir = (root: string, n: number) => join(root, '.dev', `runbook-${n}`);
const escape = (name: string) => name.replace(/[\\*?[\]{}]/g, '\\$&');
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function lsNames(home: string, root: string, dir: string): string[] {
  const r = mc(home, root, ['ls', ...(dir ? [dir] : [])]);
  if (r.status !== 0) fail(`bin/mc ls ${dir || '.'} failed:\n${r.out.trim()}`);
  return r.out.split('\n').filter(Boolean);
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

// Pull every unit into home, refuse drift, lay issue/N's versions over the
// pulled copies and return the units with their diffs. Writes nothing live.
function prepare(root: string, n: number, set: PushSet, home: string): { units: Unit[]; diffs: string[] } {
  const drift = mainDrift(root, n, [...set.changed, ...set.added]);
  if (drift.length) fail(`main changed ${drift.join(', ')} after issue/${n} was cut (live drift synced in); merge main into issue/${n}, re-verify, and push again`);
  const units: Unit[] = [];
  // Added files: walk down from the root while live has the directory.
  const anchors = new Map<string, { children: Set<string>; files: string[] }>();
  const listings = new Map<string, string[]>();
  const list = (d: string) => listings.get(d) ?? (listings.set(d, lsNames(home, root, d)), listings.get(d)!);
  for (const p of set.added) {
    const parts = p.split('/');
    let i = 0;
    while (i < parts.length - 1 && list(parts.slice(0, i).join('/')).includes(`${parts[i]}/`)) i++;
    const anchor = parts.slice(0, i).join('/');
    if (list(anchor).includes(parts[i]) || list(anchor).includes(`${parts[i]}/`)) fail(`live already has server/${parts.slice(0, i + 1).join('/')}, which issue/${n} adds: run bin/dev sync, merge main into issue/${n}, and re-verify`);
    if (anchor === '') fail(`issue/${n} adds ${parts[0]} at the top of the server root; upload it by hand (bin/mc pushes no root-level new path)`);
    const a = anchors.get(anchor) ?? { children: new Set<string>(), files: [] };
    a.children.add(parts[i]);
    a.files.push(p);
    anchors.set(anchor, a);
  }
  for (const [anchor, a] of anchors) {
    const exclude = join(runDir(root, n), 'exclude', createHash('sha1').update(anchor).digest('hex'));
    mkdirSync(dirname(exclude), { recursive: true });
    writeFileSync(exclude, list(anchor).map((e) => e.replace(/\/$/, '')).filter((e) => !a.children.has(e)).flatMap((e) => [`/${escape(e)}`, `/${escape(e)}/**`]).join('\n') + '\n');
    units.push({ transfer: anchor, files: a.files, added: true, exclude });
  }
  for (const p of set.changed) units.push({ transfer: p, files: [p], added: false });
  const diffs: string[] = [];
  for (const u of units) {
    rmSync(join(home, 'server', u.transfer), { recursive: true, force: true });
    const r = mc(home, root, ['pull', u.transfer], u.exclude);
    if (r.status !== 0) fail(`could not pull ${u.transfer} from live${u.added ? '' : ' (deleted on live?)'}:\n${r.out.trim()}`);
    if (u.added) {
      const there = files(join(home, 'server', u.transfer));
      if (there.length) fail(`live gained files where issue/${n} adds new ones (${there.map((f) => f.slice(join(home, 'server').length + 1)).join(', ')}): run bin/dev sync and re-verify`);
    } else if (!readFileSync(join(home, 'server', u.transfer)).equals(blob(root, 'main', u.transfer))) {
      fail(`live's ${u.transfer} differs from main's: live changed since the last sync; run bin/dev sync, merge main into issue/${n} if it touched the file, and re-verify`);
    }
    for (const f of u.files) {
      mkdirSync(dirname(join(home, 'server', f)), { recursive: true });
      writeFileSync(join(home, 'server', f), blob(root, `issue/${n}`, f));
    }
    const d = mc(home, root, ['diff', u.transfer], u.exclude);
    if (d.status > 1) fail(`bin/mc diff ${u.transfer} failed:\n${d.out.trim()}`);
    diffs.push(d.out.trimEnd());
  }
  return { units, diffs };
}

function requireRunbook(root: string, n: number): void {
  const docs = mustGit(root, ['ls-tree', '-r', '--name-only', `issue/${n}`, '--', 'docs/runbooks/']).split('\n');
  if (!docs.some((f) => new RegExp(`^docs/runbooks/\\d{4}-\\d{2}-\\d{2}-${n}-`).test(f))) fail(`issue/${n} has no committed docs/runbooks/<date>-${n}-<slug>.md: pass the gate, run bin/check runbook <id>, commit it, then push`);
}

export function runbookPush(root: string, n: number, plan: boolean): void {
  const set = pushSet(root, n);
  for (const p of set.notPushed) say(`not pushed: ${p}`);
  for (const p of set.deleted) say(`manual: delete server/${p} on live by hand (the push never deletes)`);
  if (set.changed.length + set.added.length === 0) {
    say(`runbook: nothing under server/ to push for issue/${n}`);
    return;
  }
  if (!plan) requireRunbook(root, n);
  const dir = privateDir(runDir(root, n));
  const home = privateDir(join(dir, 'home'));
  const { units, diffs } = prepare(root, n, set, home);
  for (const u of units) say(`push: ${u.files.join(', ')}${u.added ? ' (new)' : ''}`);
  say(diffs.filter(Boolean).join('\n'));
  if (plan) {
    say(`runbook: plan only; no drift; bin/check runbook push ${n} uploads the ${units.reduce((s, u) => s + u.files.length, 0)} file(s) above`);
    return;
  }
  const journal = join(dir, 'journal.jsonl');
  const run = new Date().toISOString();
  for (const u of units) {
    const r = mc(home, root, ['push', u.transfer], u.exclude, { MC_RUNBOOK: '1' });
    const m = /previous remote copy (?:is )?in (.+?)\/remote\//.exec(r.out);
    const backup = m ? (isAbsolute(m[1]) ? m[1] : join(home, m[1])) : undefined;
    const entry: Journal = { run, time: new Date().toISOString(), issue: n, transfer: u.transfer, files: u.files, added: u.added, status: r.status === 0 ? 'ok' : 'failed', ...(backup ? { backup } : {}), ...(r.status === 0 ? {} : { error: r.out.trim() }) };
    appendFileSync(journal, `${JSON.stringify(entry)}\n`);
    if (r.status !== 0) fail(`push of ${u.transfer} failed; stopped (journal ${journal}):\n${r.out.trim()}\nbin/check runbook rollback ${n} prints the restore commands`);
    say(`pushed: ${u.files.join(', ')}`);
  }
  say(`runbook: pushed ${units.reduce((s, u) => s + u.files.length, 0)} file(s) for issue/${n}; journal ${journal}. Now apply it (reload or panel restart) and run the live check`);
}

// The restore commands for the last push run, newest first. Printed only:
// the user runs them after an OK.
export function runbookRollback(root: string, n: number): string[] {
  const journal = join(runDir(root, n), 'journal.jsonl');
  if (!existsSync(journal)) fail(`no push journal for issue ${n} (${journal})`);
  const entries = readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Journal);
  const last = entries.at(-1)!.run;
  const home = join(runDir(root, n), 'home');
  const env = `MC_HOME=${q(home)} MC_ENV_FILE=${q(envFile(root))}`;
  const mcBin = q(join(HARNESS_ROOT, 'bin/mc'));
  const lines: string[] = [`# rollback of the push run ${last} for issue ${n}, newest first`];
  for (const e of entries.filter((x) => x.run === last).reverse()) {
    if (e.added) {
      lines.push(`# new on live: delete by hand: ${e.files.map((f) => `server/${f}`).join(', ')}`);
    } else if (!e.backup) {
      lines.push(`# ${e.transfer}: nothing was written (${e.status})`);
    } else {
      lines.push(`# ${e.transfer} (${e.status})`, `${env} ${mcBin} pull ${q(e.transfer)}`, `cp ${q(join(e.backup, 'remote', e.transfer))} ${q(join(home, 'server', e.transfer))}`, `${env} MC_RUNBOOK=1 ${mcBin} push ${q(e.transfer)}`);
    }
  }
  return lines;
}
