// bin/check postmortem and runbook: render templates/{postmortem,runbook}.md
// into docs/postmortems/ and docs/runbooks/ of the project, only for a check
// whose gate passed and whose green was confirmed by bin/check gate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from '../dev/docker.ts';
import { git, HARNESS_ROOT } from '../dev/image.ts';
import type { RunRecord } from '../check/record.ts';

export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in values)) fail(`template field {{${k}}} has no value`);
    return values[k];
  });
}

const json = ({ output: _, ...rest }: RunRecord) => JSON.stringify(rest, null, 2);

const PATCH_LINES = 400;

// The server/ diff of the fix, for the postmortem's review section.
function serverPatch(root: string, red: string, green: string): string {
  const lines = mustGit(root, ['diff', '--no-color', red, green, '--', 'server/']).split('\n');
  return lines.length <= PATCH_LINES ? lines.join('\n') : `${lines.slice(0, PATCH_LINES).join('\n')}\n... ${lines.length - PATCH_LINES} more lines: git diff ${red.slice(0, 12)} ${green.slice(0, 12)} -- server/`;
}

function mustGit(root: string, args: string[]): string {
  const r = git(root, args);
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// The runbook's push list: server/ changes since the merge-base with base,
// prefix stripped; deletions are manual steps, never pushed.
export function pushList(root: string, base: string): string {
  const lines = mustGit(root, ['diff', '--name-status', '--no-renames', `${base}...HEAD`, '--', 'server/']).split('\n').filter(Boolean);
  if (lines.length === 0) return '   - none: nothing under server/ differs';
  return lines.map((l) => {
    const [status, path] = l.split('\t');
    const rel = path.slice('server/'.length);
    return status === 'D' ? `   - \`${rel}\` (deleted: remove it on live by hand; the push never deletes)` : `   - \`${rel}\``;
  }).join('\n');
}

export function writeDoc(root: string, kind: 'postmortem' | 'runbook', red: RunRecord, green: RunRecord, confirm: RunRecord): string {
  const date = new Date().toLocaleDateString('sv');
  const slug = red.check.replace(new RegExp(`^${red.issue}-`), '');
  const dir = join(root, 'docs', kind === 'postmortem' ? 'postmortems' : 'runbooks');
  const file = join(dir, `${date}-${red.issue}-${slug}.md`);
  if (existsSync(file)) fail(`${file} exists; edit it instead`);
  const base = 'main';
  if (kind === 'runbook' && git(root, ['rev-parse', '--verify', '-q', base]).status !== 0) fail(`no ${base} branch to diff the push set against`);
  const values: Record<string, string> = {
    title: slug.replace(/-/g, ' '),
    issue: String(red.issue),
    date,
    check: red.check,
    redCommit: red.commit,
    greenCommit: green.commit,
    ...(kind === 'postmortem'
      ? { serverDiff: mustGit(root, ['diff', '--stat', red.commit, green.commit, '--', 'server/']), serverPatch: serverPatch(root, red.commit, green.commit), red: json(red), green: json(green), confirm: json(confirm), redOutput: red.output }
      : { base, files: pushList(root, base) }),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, render(readFileSync(join(HARNESS_ROOT, 'templates', `${kind}.md`), 'utf8'), values));
  return file;
}
