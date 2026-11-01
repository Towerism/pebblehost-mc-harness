// Thin docker CLI wrapper. MC_DOCKER overrides the binary; unit tests point
// it at a fake that records argv.
import { spawnSync } from 'node:child_process';

export type Result = { status: number; stdout: string; stderr: string };
// env: extra variables for the docker client, for values that must stay out
// of argv (`-e NAME` without a value reads them from here). input: stdin.
export type Docker = (args: string[], opts?: { inherit?: boolean; env?: Record<string, string>; input?: string }) => Result;

export class DevError extends Error {}

// Refusals and failures: the CLI prints the message and exits 2.
export function fail(msg: string): never {
  throw new DevError(msg);
}

export const docker: Docker = (args, opts = {}) => {
  const r = spawnSync(process.env.MC_DOCKER || 'docker', args, {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    maxBuffer: 1 << 30,
    input: opts.input,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', ...(opts.inherit ? (['inherit', 'inherit'] as const) : (['pipe', 'pipe'] as const))],
  });
  if (r.error) fail(`cannot run docker: ${r.error.message}`);
  return { status: r.status ?? 2, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// Run docker and fail with its stderr unless it exits 0.
export function must(d: Docker, args: string[], env?: Record<string, string>): string {
  const r = d(args, { env });
  if (r.status !== 0) fail(`docker ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
