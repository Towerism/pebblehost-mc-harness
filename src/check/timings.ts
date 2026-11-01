// The suite's timings: what timings.json holds, the printed table, and the
// budget from checks/budget.json ({"seconds": N}).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from '../dev/docker.ts';

export type TestTime = { check: string; pass: boolean; seconds: number; skipped?: boolean };
export type Timings = {
  started: string;
  target: 'dev' | 'live';
  commit: string;
  image: { cacheHit: boolean; seconds: number } | null;
  unit: TestTime[];
  profiles: { pod: string; key: string; reset: string; boot: number; teardown: number; tests: TestTime[] }[];
  // Checks that could not run: a bad profile, conflicting fixtures, no tests.
  refused: { check: string; reason: string }[];
  total: number;
  budget: number | null;
  over: number | null;
};

export function readBudget(root: string): number | null {
  const f = join(root, 'checks', 'budget.json');
  if (!existsSync(f)) return null;
  let b: { seconds?: unknown };
  try {
    b = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    fail('checks/budget.json is not JSON');
  }
  if (typeof b.seconds !== 'number' || !(b.seconds > 0)) fail('checks/budget.json: seconds must be a positive number');
  return b.seconds;
}

export function writeTimings(file: string, t: Timings): void {
  writeFileSync(file, `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
}

const s = (n: number) => `${n.toFixed(1)}s`;

export function formatTimings(t: Timings): string {
  const rows: [string, string][] = [];
  if (t.image) rows.push([`image (${t.image.cacheHit ? 'cache hit' : 'built'})`, s(t.image.seconds)]);
  for (const u of t.unit) rows.push([`${t.target === 'live' ? 'live' : 'unit'} ${u.check}`, `${s(u.seconds)} ${u.skipped ? 'skip' : u.pass ? 'pass' : 'FAIL'}`]);
  for (const p of t.profiles) {
    rows.push([`boot ${p.pod} (${p.tests.length} check(s), reset: ${p.reset})`, s(p.boot)]);
    for (const x of p.tests) rows.push([`  ${x.check}`, `${s(x.seconds)} ${x.pass ? 'pass' : 'FAIL'}`]);
    rows.push([`teardown ${p.pod}`, s(p.teardown)]);
  }
  for (const r of t.refused) rows.push([`refused ${r.check}`, r.reason.split('\n')[0]]);
  rows.push(['total', `${s(t.total)}${t.budget === null ? '' : ` (budget ${s(t.budget)})`}`]);
  const w = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`);
  if (t.over !== null) lines.push(`OVER BUDGET by ${s(t.over)}`);
  return lines.join('\n');
}
