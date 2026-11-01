// bin/check: run checks, record them, and gate the red→green pair.
// Exit 0 ok (a check that passed), 1 a check that failed (recorded), 2
// refused or failed to run. Never prompts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DevError, docker as d, fail } from '../dev/docker.ts';
import { HARNESS_ROOT, labels } from '../dev/image.ts';
import { isExplored, names, podOf, state } from '../dev/pod.ts';
import { parseBareText } from '../gate/bareText.ts';
import { writeDoc } from '../gate/docs.ts';
import { confirmOf, evaluate, gitRepo, type Verdict } from '../gate/gate.ts';
import { issueOf, readRecords, runsFile, type Kind, type RunRecord } from './record.ts';
import { readProfile, runCheck } from './run.ts';

const USAGE = `usage: check <command> <id> [options]

  run <id> [--fresh] [--pod ID] [--timeout S]
                          run checks/<id>/*.test.ts (node --test) against the
                          pod (e2e) or the committed server/ (bare-text), and
                          append a record to .verify/runs/issue-N.jsonl
  gate <id> [--no-confirm] [--pod ID]
                          check the red→green pair (rules G1-G10), then re-run
                          the green on the pod booted from its image
  postmortem <id>         write docs/postmortems/<date>-<N>-<slug>.md
  runbook <id>            write docs/runbooks/<date>-<N>-<slug>.md
                          (both only after a confirmed gate pass)

--fresh rebuilds the pod from HEAD on a new volume first: only a red run on
such a volume, untouched by bin/dev console or join, counts for the gate.
checks/<id>/profile.json gives the kind: {"kind": "e2e"} or {"kind":
"bare-text"}. checks/<id>/ must be committed. N comes from the branch issue/N
or --issue N. The project is $MC_HOME (default: the harness root).
Exit codes: 0 passed, 1 failed (recorded), 2 refused.`;

type Opts = { id?: string; issue?: string; pod: string; fresh: boolean; confirm: boolean; timeout: number };

function parse(argv: string[]): { cmd: string; o: Opts } {
  const o: Opts = { pod: 'dev', fresh: false, confirm: true, timeout: 600 };
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') fail(USAGE);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i] ?? fail(`${a} needs a value\n${USAGE}`);
    if (a === '--issue') o.issue = val();
    else if (a === '--pod') o.pod = val();
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--no-confirm') o.confirm = false;
    else if (!a.startsWith('-') && o.id === undefined) o.id = a;
    else fail(`unexpected argument ${a}\n${USAGE}`);
  }
  if (!(o.timeout > 0)) fail(`bad --timeout\n${USAGE}`);
  return { cmd, o };
}

const say = (msg: string) => process.stdout.write(`${msg}\n`);
const short = (s: string) => s.slice(0, 12);

// G8 and G4 input for a bare-text check: the problems of its files (G2
// holds them clean; ignored files count too) and the server files read.
function bareTextOf(root: string, id: string): { staticProblems: string[]; bareFiles: string[] } {
  const dir = join(root, 'checks', id);
  const staticProblems: string[] = [];
  const bareFiles: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isFile() && e.name === 'profile.json') continue;
    if (!e.isFile() || !e.name.endsWith('.test.ts')) {
      staticProblems.push(`checks/${id}/${e.name}: a bare-text check holds only profile.json and *.test.ts`);
      continue;
    }
    const { problems, files } = parseBareText(readFileSync(join(dir, e.name), 'utf8'));
    staticProblems.push(...problems.map((p) => `${e.name}: ${p}`));
    bareFiles.push(...files);
  }
  return { staticProblems, bareFiles: [...new Set(bareFiles)] };
}

function verdict(root: string, id: string, issue: number, records: RunRecord[]): Verdict & { kind: Kind } {
  const { kind } = readProfile(root, id);
  const bare = kind === 'bare-text' ? bareTextOf(root, id) : { staticProblems: [], bareFiles: [] };
  return { ...evaluate(records, { id, issue, kind, ...bare }, gitRepo(root)), kind };
}

function main(argv: string[]) {
  const { cmd, o } = parse(argv);
  const root = resolve(process.env.MC_HOME || HARNESS_ROOT);
  if (!['run', 'gate', 'postmortem', 'runbook'].includes(cmd)) fail(`unknown command ${cmd}\n${USAGE}`);
  if (o.id === undefined) fail(`${cmd} needs a check id\n${USAGE}`);
  const issue = issueOf(root, o.issue);
  switch (cmd) {
    case 'run': {
      const { record, output } = runCheck({ root, id: o.id, issue, pod: o.pod, fresh: o.fresh, confirm: false, timeoutS: o.timeout }, d);
      process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`);
      const counts = record.kind === 'e2e' ? `commit ${short(record.commit)}, generation ${record.generation.slice(0, 8)}${record.fresh ? ' (fresh)' : ''}${record.explored ? ' (explored: does not count as a red)' : ''}` : `commit ${short(record.commit)}`;
      say(`run: ${o.id} ${record.pass ? 'passed' : 'failed'} (${record.kind}, ${counts}); recorded in ${runsFile(root, issue)}`);
      process.exitCode = record.pass ? 0 : 1;
      break;
    }
    case 'gate': {
      const v = verdict(root, o.id, issue, readRecords(root, issue));
      if (!v.ok) fail(`gate: ${o.id} refused:\n  ${v.reasons.join('\n  ')}`);
      say(`gate: ${o.id}: red ${v.red.time} on ${short(v.red.commit)}, green ${v.green.time} on ${short(v.green.commit)}`);
      if (!o.confirm) {
        say(`gate: ${o.id} passed, not confirmed; postmortem and runbook need bin/check gate ${o.id} with its confirm run`);
        break;
      }
      // The confirm run needs the green's image running on a volume nobody
      // explored; the gate never boots one.
      if (v.kind === 'e2e') {
        const p = podOf(root, o.pod);
        const server = names(p).server;
        if (state(d, server) !== 'running' || labels(d, server)['mc-harness.image'] !== v.green.imageHash) fail(`gate: no running pod ${o.pod} booted from the green's image ${short(v.green.imageHash)}; run bin/dev rebuild first`);
        if (isExplored(p, d)) fail(`gate: pod ${o.pod}'s volume was explored (bin/dev console or join); run bin/dev rebuild first`);
      }
      const { record, output } = runCheck({ root, id: o.id, issue, pod: o.pod, fresh: false, confirm: true, timeoutS: o.timeout }, d);
      process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`);
      if (!record.pass) fail(`gate: the confirm run of ${o.id} failed; the green does not hold`);
      if (JSON.stringify(confirmOf(readRecords(root, issue), v.green)) !== JSON.stringify(record)) fail(`gate: the confirm run of ${o.id} does not match the green (fixtures, image or an explored volume)`);
      say(`gate: ${o.id} passed and confirmed; the confirm run is recorded in ${runsFile(root, issue)}: commit it`);
      break;
    }
    case 'postmortem':
    case 'runbook': {
      const records = readRecords(root, issue);
      const v = verdict(root, o.id, issue, records);
      if (!v.ok) fail(`${cmd}: the gate refuses ${o.id}:\n  ${v.reasons.join('\n  ')}`);
      const confirm = confirmOf(records, v.green);
      if (!confirm) fail(`${cmd}: the green of ${o.id} has no passing latest confirm run; run bin/check gate ${o.id}`);
      say(`${cmd}: wrote ${writeDoc(root, cmd, v.red, v.green, confirm)}`);
      break;
    }
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof DevError)) throw e;
  process.stderr.write(`check: ${e.message}\n`);
  process.exit(2);
}
