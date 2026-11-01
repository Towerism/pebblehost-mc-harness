// bin/check suite: every committed check, bare-text first (no pod), then one
// pod per distinct fixture profile with all its e2e checks, torn down once
// per profile, pass or fail. Writes .dev/runs/<ts>/timings.json.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../dev/cli.ts';
import { fail, must, type Docker } from '../dev/docker.ts';
import { dirtyServer, privateDir, source, walk } from '../dev/image.ts';
import { mergeFixtures, names, podOf, readPodFile, removePod, restartServer, type Pod } from '../dev/pod.ts';
import { fixtureDirs, isData, readProfile, type Profile } from './profile.ts';
import { checkEnv, checkHash, committedTests, refuseDirtyHarness, runTests } from './run.ts';
import { readBudget, writeTimings, type Timings } from './timings.ts';

export type SuiteCheck = { id: string; profile: Profile; fixturesHash: string; hasData: boolean };
type Info = SuiteCheck & { files: string[]; fixtures: string[] };

// Between two checks on one pod: a restart that applies the fixtures again
// (data: plugins hold it in memory), a copy of the fixture files, or nothing.
export type Reset = 'reset' | 'restore' | 'none';
export type Group = { key: string; checks: string[]; reset: Reset };
export type Plan = { unit: string[]; groups: Group[] };

// Bare-text checks run first, with no pod. e2e checks share a pod when their
// merged fixtures are the same; an exclusive check gets its own; checks that
// restart the server run last on theirs.
export function planSuite(checks: SuiteCheck[]): Plan {
  const sorted = [...checks].sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Map<string, SuiteCheck[]>();
  for (const c of sorted.filter((c) => c.profile.kind === 'e2e')) {
    const key = c.profile.exclusive ? `exclusive:${c.id}` : `fixtures:${c.fixturesHash}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return {
    unit: sorted.filter((c) => c.profile.kind === 'bare-text').map((c) => c.id),
    groups: [...groups].map(([key, cs]) => ({
      key,
      checks: [...cs.filter((c) => !c.profile.restart), ...cs.filter((c) => c.profile.restart)].map((c) => c.id),
      reset: cs.some((c) => c.hasData) ? 'reset' : cs.some((c) => c.profile.fixtures.length > 0) ? 'restore' : 'none',
    })),
  };
}

export type SuiteOpts = { root: string; timeoutS: number; jar?: string; heap?: string };
export type SuiteResult = { timings: Timings; file: string; failed: string[] };

const say = (msg: string) => process.stdout.write(`${msg}\n`);

export function runSuite(o: SuiteOpts, d: Docker): SuiteResult {
  refuseDirtyHarness();
  const src = source(o.root);
  if (src.kind !== 'git') fail('the suite runs the committed tree; server/ is not tracked');
  const dirty = dirtyServer(src);
  if (dirty.length > 0) fail(`server/ has uncommitted changes; commit them first:\n${dirty.join('\n')}`);
  const dir = join(o.root, 'checks');
  const ids = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'profile.json'))).map((e) => e.name) : [];
  if (ids.length === 0) fail('no checks/<id>/profile.json to run');
  const info = new Map<string, Info>(ids.map((id) => {
    const profile = readProfile(o.root, id);
    const files = committedTests(o.root, id, checkHash(o.root, id), profile);
    const fixtures = fixtureDirs(o.root, id, profile);
    const tmp = mkdtempSync(join(tmpdir(), 'suite-fx-'));
    try {
      const fixturesHash = mergeFixtures(fixtures, tmp);
      const hasData = profile.data.length > 0 || walk(tmp).some((rel) => isData(rel, profile));
      return [id, { id, profile, files, fixtures, fixturesHash, hasData }];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }));
  const plan = planSuite([...info.values()]);
  const dev = readPodFile(podOf(o.root, 'dev'));
  const t0 = Date.now();
  const timings: Timings = { started: new Date().toISOString(), commit: src.commit, image: null, unit: [], profiles: [], total: 0, budget: readBudget(o.root), over: null };
  const failed: string[] = [];
  const test = (id: string, pod: string) => {
    const c = info.get(id) as Info;
    const r = runTests(o.root, id, c.files, checkEnv(o.root, id, pod, src.commit, c.profile), o.timeoutS);
    say(`${r.pass ? 'PASS' : 'FAIL'} ${id} (${r.seconds.toFixed(1)}s)`);
    if (!r.pass) {
      failed.push(id);
      say(r.output.trimEnd().split('\n').slice(-20).map((l) => `  ${l}`).join('\n'));
    }
    return { check: id, pass: r.pass, seconds: r.seconds };
  };
  // Pods still up; torn down on the way out, also on SIGINT/SIGTERM.
  const up: Pod[] = [];
  const teardown = (p: Pod) => {
    removePod(p, false, d);
    up.splice(up.indexOf(p), 1);
  };
  const cleanup = () => {
    for (const p of [...up]) {
      try {
        teardown(p);
      } catch (e) {
        process.stderr.write(`check: teardown of pod ${p.pod} failed: ${(e as Error).message}\n`);
      }
    }
  };
  const onSignal = (sig: NodeJS.Signals) => {
    cleanup();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    for (const id of plan.unit) timings.unit.push(test(id, 'dev'));
    plan.groups.forEach((g, i) => {
      const p = podOf(o.root, `suite${i}`);
      up.push(p);
      say(`profile ${i + 1}/${plan.groups.length}: ${g.checks.join(', ')} on pod ${p.pod}`);
      const fixtures = [...new Set(g.checks.flatMap((id) => info.get(id)?.fixtures ?? []))];
      const b = boot(p, { fixtures, jar: o.jar ?? dev.jar, heap: o.heap ?? dev.heap }, undefined, true);
      timings.image ??= { cacheHit: b.cacheHit, seconds: b.buildSeconds };
      const tests = g.checks.map((id, j) => {
        if (j > 0 && g.reset === 'reset') restartServer(p, d, true);
        if (j > 0 && g.reset === 'restore') must(d, ['exec', names(p).server, 'cp', '-R', '/fixtures/.', '/server/']);
        return test(id, p.pod);
      });
      const t = Date.now();
      teardown(p);
      timings.profiles.push({ pod: p.pod, key: g.key, reset: g.reset, boot: b.bootSeconds, teardown: (Date.now() - t) / 1000, tests });
    });
  } finally {
    cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  timings.total = (Date.now() - t0) / 1000;
  if (timings.budget !== null && timings.total > timings.budget) timings.over = timings.total - timings.budget;
  const runs = privateDir(join(privateDir(join(o.root, '.dev')), 'runs'));
  const out = privateDir(join(runs, timings.started.replace(/[:.]/g, '-')));
  const file = join(out, 'timings.json');
  writeTimings(file, timings);
  return { timings, file, failed };
}
