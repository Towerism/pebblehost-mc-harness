// bin/check: run checks and record them for the red→green gate.
// Exit 0 ok (a check that passed), 1 a check that failed (recorded), 2
// refused or failed to run. Never prompts.
import { resolve } from 'node:path';
import { DevError, docker as d, fail } from '../dev/docker.ts';
import { HARNESS_ROOT } from '../dev/image.ts';
import { issueOf, runsFile } from './record.ts';
import { runCheck } from './run.ts';

const USAGE = `usage: check <command> <id> [options]

  run <id> [--fresh] [--pod ID] [--timeout S]
                          run checks/<id>/*.test.ts (node --test) against the
                          pod (e2e) or the committed server/ (bare-text), and
                          append a record to .verify/runs/issue-N.jsonl

--fresh rebuilds the pod from HEAD on a new volume first: only a red run on
such a volume, untouched by bin/dev console or join, counts for the gate.
checks/<id>/profile.json gives the kind: {"kind": "e2e"} or {"kind":
"bare-text"}. checks/<id>/ must be committed. N comes from the branch issue/N
or --issue N. The project is $MC_HOME (default: the harness root).
Exit codes: 0 passed, 1 failed (recorded), 2 refused.`;

type Opts = { id?: string; issue?: string; pod: string; fresh: boolean; timeout: number };

function parse(argv: string[]): { cmd: string; o: Opts } {
  const o: Opts = { pod: 'dev', fresh: false, timeout: 600 };
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') fail(USAGE);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i] ?? fail(`${a} needs a value\n${USAGE}`);
    if (a === '--issue') o.issue = val();
    else if (a === '--pod') o.pod = val();
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--fresh') o.fresh = true;
    else if (!a.startsWith('-') && o.id === undefined) o.id = a;
    else fail(`unexpected argument ${a}\n${USAGE}`);
  }
  if (!(o.timeout > 0)) fail(`bad --timeout\n${USAGE}`);
  return { cmd, o };
}

function main(argv: string[]) {
  const { cmd, o } = parse(argv);
  const root = resolve(process.env.MC_HOME || HARNESS_ROOT);
  switch (cmd) {
    case 'run': {
      if (o.id === undefined) fail(`run needs a check id\n${USAGE}`);
      const issue = issueOf(root, o.issue);
      const { record, output } = runCheck({ root, id: o.id, issue, pod: o.pod, fresh: o.fresh, confirm: false, timeoutS: o.timeout }, d);
      process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`);
      const counts = record.kind === 'e2e' ? `commit ${record.commit.slice(0, 12)}, generation ${record.generation.slice(0, 8)}${record.fresh ? ' (fresh)' : ''}${record.explored ? ' (explored: does not count as a red)' : ''}` : `commit ${record.commit.slice(0, 12)}`;
      process.stdout.write(`run: ${o.id} ${record.pass ? 'passed' : 'failed'} (${record.kind}, ${counts}); recorded in ${runsFile(root, issue)}\n`);
      process.exitCode = record.pass ? 0 : 1;
      break;
    }
    default:
      fail(`unknown command ${cmd}\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof DevError)) throw e;
  process.stderr.write(`check: ${e.message}\n`);
  process.exit(2);
}
