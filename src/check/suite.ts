// bin/check suite: every committed check, bare-text first (no pod), then one
// pod per distinct fixture profile with all its e2e checks, torn down once
// per profile, pass or fail. Writes .dev/runs/<ts>/timings.json.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../dev/cli.ts';
import { DevError, fail, must, type Docker } from '../dev/docker.ts';
import { dirtyServer, privateDir, source, walk } from '../dev/image.ts';
import { mergeFixtures, names, podOf, readPodFile, relayRequest, removePod, restartServer, type Pod } from '../dev/pod.ts';
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
export type SuiteResult = { timings: Timings; file: string; checks: number; failed: string[] };

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
  // A check that can't run (bad profile, fixture conflict, uncommitted,
  // no tests) is refused alone; the others still run.
  const refused: { check: string; reason: string }[] = [];
  const refuse = (check: string, e: unknown) => {
    if (!(e instanceof DevError)) throw e;
    refused.push({ check, reason: e.message });
    say(`REFUSED ${check}: ${e.message.split('\n')[0]}`);
  };
  const info = new Map<string, Info>();
  for (const id of ids) {
    const tmp = mkdtempSync(join(tmpdir(), 'suite-fx-'));
    try {
      const profile = readProfile(o.root, id);
      const files = committedTests(o.root, id, checkHash(o.root, id), profile);
      const fixtures = fixtureDirs(o.root, id, profile);
      const fixturesHash = mergeFixtures(fixtures, tmp);
      const hasData = profile.data.length > 0 || walk(tmp).some((rel) => isData(rel, profile));
      info.set(id, { id, profile, files, fixtures, fixturesHash, hasData });
    } catch (e) {
      refuse(id, e);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const plan = planSuite([...info.values()]);
  const dev = readPodFile(podOf(o.root, 'dev'));
  const t0 = Date.now();
  const timings: Timings = { started: new Date().toISOString(), commit: src.commit, image: null, unit: [], profiles: [], refused, total: 0, budget: readBudget(o.root), over: null };
  const failed: string[] = [];
  const test = (id: string, pod: string) => {
    const c = info.get(id) as Info;
    let r: ReturnType<typeof runTests>;
    try {
      r = runTests(o.root, id, c.files, checkEnv(o.root, id, pod, src.commit, c.profile), o.timeoutS);
    } catch (e) {
      refuse(id, e);
      return { check: id, pass: false, seconds: 0 };
    }
    say(`${r.pass ? 'PASS' : 'FAIL'} ${id} (${r.seconds.toFixed(1)}s)`);
    if (!r.pass) {
      failed.push(id);
      say(r.output.trimEnd().split('\n').slice(-20).map((l) => `  ${l}`).join('\n'));
    }
    return { check: id, pass: r.pass, seconds: r.seconds };
  };
  // Pods still up; torn down on the way out. bin/check suite runs this in a
  // child process; on SIGINT/SIGTERM its parent kills it and removes every
  // suite pod by label (teardownSuitePods), since nothing here can yield to
  // a signal handler.
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
        // Bot players from the previous check leave first.
        if (j > 0) relayRequest(p, d, { op: 'bot.quitAll' });
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
  }
  timings.total = (Date.now() - t0) / 1000;
  if (timings.budget !== null && timings.total > timings.budget) timings.over = timings.total - timings.budget;
  const runs = privateDir(join(privateDir(join(o.root, '.dev')), 'runs'));
  const out = privateDir(join(runs, timings.started.replace(/[:.]/g, '-')));
  const file = join(out, 'timings.json');
  writeTimings(file, timings);
  return { timings, file, checks: ids.length, failed: [...refused.map((r) => r.check), ...failed] };
}

// Remove every suite pod of the project (labels mc-harness.pod=suite<N>):
// containers, volumes and networks. Returns how many resources went.
export function teardownSuitePods(root: string, d: Docker): number {
  const project = podOf(root, 'dev').project;
  const pods = new Set<string>();
  for (const args of [['ps', '-a'], ['volume', 'ls'], ['network', 'ls']]) {
    for (const pod of must(d, [...args, '--filter', `label=mc-harness.project=${project}`, '--format', '{{.Label "mc-harness.pod"}}']).split('\n')) if (/^suite\d+$/.test(pod)) pods.add(pod);
  }
  let n = 0;
  for (const pod of pods) n += removePod(podOf(root, pod), false, d);
  return n;
}
