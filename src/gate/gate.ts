// The red→green gate (G1–G9): a failing and a later passing run of the same
// committed check, where the green booted a strict descendant commit that
// changed server/, both runs' identities hold, and the red ran on a fresh
// volume nobody had explored. Pure over the records and a GateRepo, so the
// unit tests can drive every refusal.
import { createHash } from 'node:crypto';
import { git } from '../dev/image.ts';
import type { Kind, RunRecord } from '../check/record.ts';

export type GateRepo = {
  head(): string;
  // The git tree id of checks/<id> at rev, or null.
  checkHashAt(rev: string, id: string): string | null;
  checkClean(id: string): boolean;
  // a is b or an ancestor of b.
  isAncestor(a: string, b: string): boolean;
  serverChanged(a: string, b: string): boolean;
  serverTree(commit: string): string | null;
};

export type Verdict = { ok: true; red: RunRecord; green: RunRecord } | { ok: false; reasons: string[] };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const short = (s: string) => s.slice(0, 12) || '(none)';

// Why the pair fails, rule by rule; empty when it passes.
export function pairProblems(red: RunRecord, green: RunRecord, kind: Kind, repo: GateRepo, staticProblems: string[]): string[] {
  const out: string[] = [];
  const e2e = kind === 'e2e';
  for (const [name, r] of [['red', red], ['green', green]] as const) {
    if (r.target !== 'dev' || r.kind !== kind) out.push(`G1: the ${name} run is ${r.target}/${r.kind}, not dev/${kind}`);
  }
  const head = repo.head();
  const atHead = repo.checkHashAt(head, red.check);
  if (red.checkHash !== green.checkHash || green.checkHash !== atHead) out.push(`G2: the check changed: red ${short(red.checkHash)}, green ${short(green.checkHash)}, HEAD ${short(atHead ?? '')}; run it red again`);
  if (!repo.checkClean(red.check)) out.push(`G2: checks/${red.check} has uncommitted changes`);
  if (red.commit === green.commit || !repo.isAncestor(red.commit, green.commit)) out.push(`G3: the green booted ${short(green.commit)}, not a strict descendant of the red's ${short(red.commit)}${e2e ? '; commit the fix and bin/dev rebuild' : ''}`);
  else if (!repo.serverChanged(red.commit, green.commit)) out.push(`G4: no server/ change between ${short(red.commit)} and ${short(green.commit)}`);
  if (e2e) {
    for (const [name, r] of [['red', red], ['green', green]] as const) {
      if (r.source !== 'archive') out.push(`G5: the ${name} image was built from ${r.source || 'nothing'}, not a commit`);
      else if (r.treeHash !== repo.serverTree(r.commit) || r.imageHash !== sha256(`${r.treeHash}\n${r.harnessHash}`)) out.push(`G5: the ${name} record's tree or image hash does not match commit ${short(r.commit)}`);
    }
    if (red.fixturesHash !== green.fixturesHash) out.push(`G6: the fixtures changed between red and green`);
    if (!red.fresh) out.push(`G9: the red ran on volume ${short(red.generation)}, which bin/check run --fresh did not make`);
    else if (red.explored) out.push(`G9: the red's volume ${short(red.generation)} was explored (bin/dev console or join) before the red`);
  }
  if (!repo.isAncestor(green.commit, head)) out.push(`G7: HEAD does not descend from the green's ${short(green.commit)}`);
  if (kind === 'bare-text') out.push(...staticProblems.map((p) => `G8: ${p}`));
  return out;
}

// The newest green with an earlier red that passes every rule. Otherwise
// the reasons for the newest green and its newest earlier red.
export function evaluate(records: RunRecord[], id: string, kind: Kind, repo: GateRepo, staticProblems: string[] = []): Verdict {
  const runs = records.filter((r) => r.check === id && !r.confirm);
  const greens = runs.map((r, i) => [r, i] as const).filter(([r]) => r.pass).reverse();
  if (greens.length === 0) return { ok: false, reasons: [`G1: no passing run of ${id}`] };
  let first: string[] | null = null;
  for (const [green, gi] of greens) {
    const reds = runs.slice(0, gi).filter((r) => !r.pass).reverse();
    for (const red of reds) {
      const problems = pairProblems(red, green, kind, repo, staticProblems);
      if (problems.length === 0) return { ok: true, red, green };
      first ??= problems;
    }
  }
  return { ok: false, reasons: first ?? [`G1: no failing run of ${id} before its passing run`] };
}

export function gitRepo(root: string): GateRepo {
  const ok = (args: string[]) => git(root, args).status === 0;
  const out = (args: string[]) => {
    const r = git(root, args);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return {
    head: () => out(['rev-parse', 'HEAD']) ?? '',
    checkHashAt: (rev, id) => out(['rev-parse', '--verify', '-q', `${rev}:checks/${id}`]),
    checkClean: (id) => out(['status', '--porcelain', '--untracked-files=all', '--', `checks/${id}`]) === '',
    isAncestor: (a, b) => /^[0-9a-f]{40}$/.test(a) && ok(['merge-base', '--is-ancestor', a, b]),
    serverChanged: (a, b) => (out(['diff', '--name-only', a, b, '--', 'server']) ?? '') !== '',
    serverTree: (c) => out(['rev-parse', '--verify', '-q', `${c}:server`]),
  };
}
