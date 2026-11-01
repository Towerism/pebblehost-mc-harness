// The red→green gate (G1–G10): a failing and a later passing run of the same
// committed check for issue N, where the green booted a strict descendant
// commit whose server/ change the check depends on, nothing in server/ or the
// check changed after it, both runs used the same committed harness, check
// code and fixtures, each was the first run on a volume nobody touched by
// hand, the red's volume was fresh, and both records are committed. Pure over
// the records and a GateRepo, so the unit tests can drive every refusal.
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
  // Paths under server/ that differ between a and b, prefix stripped.
  serverChanges(a: string, b: string): string[];
  serverTree(commit: string): string | null;
  // The lines of .verify/runs/issue-N.jsonl as committed at HEAD.
  committedRuns(issue: number): Set<string>;
};

// What the gate knows about the check: its id, issue and kind, the G8
// problems of its files, and the server files its bareText() calls read.
export type GateCheck = { id: string; issue: number; kind: Kind; staticProblems: string[]; bareFiles: string[] };

export type Verdict = { ok: true; red: RunRecord; green: RunRecord } | { ok: false; reasons: string[] };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const short = (s: string) => s.slice(0, 12) || '(none)';

// Why the pair fails, rule by rule; empty when it passes.
export function pairProblems(red: RunRecord, green: RunRecord, c: GateCheck, repo: GateRepo): string[] {
  const out: string[] = [];
  const e2e = c.kind === 'e2e';
  const both = [['red', red], ['green', green]] as const;
  for (const [name, r] of both) {
    if (r.target !== 'dev' || r.kind !== c.kind) out.push(`G1: the ${name} run is ${r.target}/${r.kind}, not dev/${c.kind}`);
    if (r.issue !== c.issue) out.push(`G1: the ${name} record belongs to issue ${r.issue}, not ${c.issue}`);
  }
  if (!(red.time < green.time)) out.push(`G1: the red (${red.time}) is not older than the green (${green.time})`);
  const head = repo.head();
  const atHead = repo.checkHashAt(head, c.id);
  if (red.checkHash !== green.checkHash || green.checkHash !== atHead) out.push(`G2: the check changed: red ${short(red.checkHash)}, green ${short(green.checkHash)}, HEAD ${short(atHead ?? '')}; run it red again`);
  if (!repo.checkClean(c.id)) out.push(`G2: checks/${c.id} has uncommitted changes`);
  if (red.commit === green.commit || !repo.isAncestor(red.commit, green.commit)) out.push(`G3: the green booted ${short(green.commit)}, not a strict descendant of the red's ${short(red.commit)}${e2e ? '; commit the fix and bin/dev rebuild' : ''}`);
  else {
    const changed = repo.serverChanges(red.commit, green.commit);
    if (changed.length === 0) out.push(`G4: no server/ change between ${short(red.commit)} and ${short(green.commit)}`);
    for (const f of e2e ? [] : c.bareFiles) if (!changed.includes(f)) out.push(`G4: the fix commits don't touch server/${f}, which the check reads`);
  }
  if (e2e) {
    for (const [name, r] of both) {
      if (r.source !== 'archive') out.push(`G5: the ${name} image was built from ${r.source || 'nothing'}, not a commit`);
      else if (r.treeHash !== repo.serverTree(r.commit) || r.imageHash !== sha256(`${r.treeHash}\n${r.harnessHash}`)) out.push(`G5: the ${name} record's tree or image hash does not match commit ${short(r.commit)}`);
    }
    if (red.harnessHash !== green.harnessHash) out.push(`G5: red and green ran different harness code (${short(red.harnessHash)}, ${short(green.harnessHash)})`);
    for (const [name, r] of both) if (r.runIndex !== 0) out.push(`G9: the ${name} was run ${r.runIndex} check run(s) into its volume ${short(r.generation)}; only the first run on a volume counts`);
    for (const [name, r] of both) if (r.concurrent) out.push(`G9: another run was logged on the ${name}'s volume ${short(r.generation)} while it ran`);
    if (red.fixturesHash !== green.fixturesHash) out.push('G6: the fixtures changed between red and green');
    if (!red.fresh) out.push(`G9: the red ran on volume ${short(red.generation)}, which bin/check run --fresh did not make`);
    for (const [name, r] of both) if (r.explored) out.push(`G9: the ${name}'s volume ${short(r.generation)} was explored (bin/dev console or join) before the run`);
  }
  if (red.toolHash !== green.toolHash) out.push(`G5: red and green ran different check or gate code (${short(red.toolHash)}, ${short(green.toolHash)})`);
  if (!repo.isAncestor(green.commit, head)) out.push(`G7: HEAD does not descend from the green's ${short(green.commit)}`);
  else {
    const after = repo.serverChanges(green.commit, head);
    if (after.length > 0) out.push(`G7: server/ changed after the green, untested: ${after.join(', ')}; rebuild and run the green again`);
  }
  if (c.kind === 'bare-text') out.push(...c.staticProblems.map((p) => `G8: ${p}`));
  const committed = repo.committedRuns(c.issue);
  for (const [name, r] of both) if (!committed.has(JSON.stringify(r))) out.push(`G10: the ${name} record is not committed as is in .verify/runs/issue-${c.issue}.jsonl; commit the records`);
  return out;
}

// The newest green with an earlier red that passes every rule. Otherwise
// the reasons for the newest green and its newest earlier red.
export function evaluate(records: RunRecord[], c: GateCheck, repo: GateRepo): Verdict {
  // Live runs (bin/check run --target live) are read-only checks after the
  // runbook; they never stand in for a red or a green.
  const runs = records.filter((r) => r.check === c.id && !r.confirm && r.target === 'dev');
  const greens = runs.map((r, i) => [r, i] as const).filter(([r]) => r.pass).reverse();
  if (greens.length === 0) return { ok: false, reasons: [`G1: no passing run of ${c.id}`] };
  let first: string[] | null = null;
  for (const [green, gi] of greens) {
    const reds = runs.slice(0, gi).filter((r) => !r.pass).reverse();
    for (const red of reds) {
      const problems = pairProblems(red, green, c, repo);
      if (problems.length === 0) return { ok: true, red, green };
      first ??= problems;
    }
  }
  return { ok: false, reasons: first ?? [`G1: no failing run of ${c.id} before its passing run`] };
}

// The latest confirm run of this green decides: it must pass, after the
// green, on the green's image and fixtures, on a volume nobody explored, with
// no run alongside, and as the next run on the green's volume (nothing else
// in between) or the first run on a new one. A later failing confirm cancels
// an earlier pass. `why` names what disqualifies it.
export function confirmCheck(records: RunRecord[], green: RunRecord): { confirm?: RunRecord; why: string } {
  const at = records.findIndex((r) => JSON.stringify(r) === JSON.stringify(green));
  if (at < 0) return { why: 'the green is not in the records' };
  const mine = records.slice(at + 1).filter((r) => r.confirm && r.check === green.check && r.issue === green.issue && r.checkHash === green.checkHash && r.imageHash === green.imageHash && r.treeHash === green.treeHash);
  const last = mine.at(-1);
  if (!last) return { why: 'no confirm run on the green\'s image' };
  const slot = green.kind === 'e2e' && last.generation === green.generation ? green.runIndex + 1 : 0;
  const why = !last.pass ? 'the latest confirm run failed'
    : last.explored ? 'the latest confirm ran on an explored volume'
    : last.concurrent ? 'another run was logged alongside the latest confirm'
    : last.fixturesHash !== green.fixturesHash ? 'the latest confirm ran with other fixtures'
    : !(last.time > green.time) ? 'the latest confirm is not newer than the green'
    : green.kind === 'e2e' && last.runIndex !== slot ? `the latest confirm was run ${last.runIndex} on its volume, not ${slot}`
    : '';
  return why ? { why } : { confirm: last, why };
}

export function confirmOf(records: RunRecord[], green: RunRecord): RunRecord | undefined {
  return confirmCheck(records, green).confirm;
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
    serverChanges: (a, b) => (out(['diff', '--name-only', '--no-renames', a, b, '--', 'server']) ?? '').split('\n').filter(Boolean).map((p) => p.slice('server/'.length)),
    serverTree: (c) => out(['rev-parse', '--verify', '-q', `${c}:server`]),
    committedRuns: (issue) => new Set((out(['show', `HEAD:.verify/runs/issue-${issue}.jsonl`]) ?? '').split('\n').filter(Boolean)),
  };
}
