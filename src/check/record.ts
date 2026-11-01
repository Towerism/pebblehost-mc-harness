// Run records: one JSON line per check run, appended to
// .verify/runs/issue-N.jsonl under the project root. The identity fields come
// from the running container's labels (e2e) or from a clean HEAD (bare-text),
// never from the working tree.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from '../dev/docker.ts';
import { git } from '../dev/image.ts';

export type Kind = 'e2e' | 'bare-text';

export type RunRecord = {
  check: string;
  issue: number;
  kind: Kind;
  target: 'dev';
  pass: boolean;
  time: string;
  // What booted (e2e: container labels) or HEAD (bare-text; no image).
  source: string;
  commit: string;
  treeHash: string;
  harnessHash: string;
  imageHash: string;
  fixturesHash: string;
  // The git tree id of the committed checks/<id>/.
  checkHash: string;
  // The volume's generation; fresh: made by --fresh; explored: a human had
  // touched it (bin/dev console, join) before this run.
  generation: string;
  fresh: boolean;
  explored: boolean;
  containerId: string;
  // How many bin/check runs the volume had before this one (0: the first).
  runIndex: number;
  // Another run was logged on the volume while this one ran (or its log line
  // vanished): its result can't be attributed to the server alone.
  concurrent: boolean;
  // The hash of the harness's check and gate code (toolHash).
  toolHash: string;
  // A re-run of the green by bin/check gate.
  confirm: boolean;
  output: string;
};

// N from --issue, else from the branch name issue/N.
export function issueOf(root: string, flag?: string): number {
  if (flag !== undefined) {
    if (!/^[1-9]\d*$/.test(flag)) fail(`bad --issue ${flag}: use a positive number`);
    return Number(flag);
  }
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
  const m = /^issue\/([1-9]\d*)$/.exec(branch);
  if (!m) fail(`branch ${branch || '(detached)'} is not issue/N; check out issue/N or pass --issue N`);
  return Number(m[1]);
}

export function runsFile(root: string, issue: number): string {
  return join(root, '.verify', 'runs', `issue-${issue}.jsonl`);
}

export function appendRecord(root: string, rec: RunRecord): void {
  mkdirSync(join(root, '.verify', 'runs'), { recursive: true });
  appendFileSync(runsFile(root, rec.issue), `${JSON.stringify(rec)}\n`);
}

export function readRecords(root: string, issue: number): RunRecord[] {
  const f = runsFile(root, issue);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try {
      return JSON.parse(l) as RunRecord;
    } catch {
      fail(`${f}:${i + 1} is not a JSON record`);
    }
  });
}
