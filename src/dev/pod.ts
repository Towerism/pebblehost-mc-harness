// A pod: one server container on its own internal network (no gateway, so no
// egress), a named volume at /server and a read-only /fixtures. Everything
// carries the labels mc-harness.project and mc-harness.pod, which down uses.
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail, must, type Docker } from './docker.ts';
import { dirHash, privateDir, walk } from './image.ts';

export const SOCAT_IMAGE = 'alpine/socat@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed';
export const MARKER = '/server/.mc-harness-seeded';

export type Pod = { root: string; project: string; pod: string };

export function podOf(root: string, pod: string): Pod {
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(pod)) fail(`bad pod name ${pod}: use a-z, 0-9, _ and -`);
  return { root, pod, project: createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 8) };
}

export function names(p: Pod) {
  const prefix = `mc-${p.project}-${p.pod}`;
  return { net: `${prefix}-net`, vol: `${prefix}-server`, server: `${prefix}-server`, join: `${prefix}-join`, joinNet: `${prefix}-joinnet`, dir: join(p.root, '.dev', 'pods', p.pod) };
}

function labelArgs(p: Pod): string[] {
  return ['--label', `mc-harness.project=${p.project}`, '--label', `mc-harness.pod=${p.pod}`];
}

// Merge fixture directories into dest; the same path from two sources with
// different content is refused. Returns the fixtures hash.
export function mergeFixtures(sources: string[], dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const from = new Map<string, string>();
  for (const src of sources) {
    for (const rel of walk(src)) {
      const prev = from.get(rel);
      if (prev !== undefined) {
        if (!readFileSync(join(src, rel)).equals(readFileSync(join(prev, rel)))) fail(`fixture conflict: ${rel} differs in ${prev} and ${src}`);
        continue;
      }
      from.set(rel, src);
      mkdirSync(dirname(join(dest, rel)), { recursive: true });
      cpSync(join(src, rel), join(dest, rel));
    }
  }
  return dirHash(dest);
}

export type Spec = { tag: string; fixtures: string; fixturesHash: string; rconPassword: string; javaOpts?: string; memory?: string };

// Network, volume and container. No published port: bin/dev join adds a proxy.
// The RCON password reaches docker through its environment, never argv.
export function createPod(p: Pod, s: Spec, d: Docker): void {
  const n = names(p);
  must(d, ['network', 'create', '--internal', '--ipv6=false', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labelArgs(p), n.net]);
  must(d, ['volume', 'create', ...labelArgs(p), n.vol]);
  const run = ['run', '-d', '--name', n.server, '--hostname', `mc-${p.pod}`, '--network', n.net, ...labelArgs(p)];
  run.push('--label', `mc-harness.fixtures=${s.fixturesHash}`);
  run.push('-v', `${n.vol}:/server`, '-v', `${s.fixtures}:/fixtures:ro`, '-e', 'RCON_PASSWORD');
  if (s.javaOpts) run.push('-e', `JAVA_OPTS=${s.javaOpts}`);
  if (s.memory) run.push('--memory', s.memory);
  run.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '4096', '--stop-timeout', '60', s.tag);
  must(d, run, { RCON_PASSWORD: s.rconPassword });
}

// A socat proxy publishing 127.0.0.1:port to the server: on its own labelled
// network (internal networks can't publish), then joined to the pod's.
export function createJoin(p: Pod, port: number, image: string, d: Docker): void {
  const n = names(p);
  must(d, ['network', 'create', '--ipv6=false', ...labelArgs(p), n.joinNet]);
  const run = ['create', '--name', n.join, '--network', n.joinNet, ...labelArgs(p), '-p', `127.0.0.1:${port}:25565`];
  run.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--read-only', '--pids-limit', '256');
  must(d, [...run, image, 'TCP-LISTEN:25565,fork,reuseaddr', `TCP:${n.server}:25565`]);
  must(d, ['network', 'connect', n.net, n.join]);
  must(d, ['start', n.join]);
}

function ids(d: Docker, kind: 'container' | 'volume' | 'network', filters: string[]): string[] {
  const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
  for (const f of filters) args.push('--filter', `label=${f}`);
  return must(d, args).split('\n').filter(Boolean);
}

// Remove every container, volume and network of the pod (with all, of every
// pod of the project, and its mc-dev images too). Containers first: they hold
// the others. A plain down keeps the image as the build cache.
export function removePod(p: Pod, all: boolean, d: Docker): number {
  const filters = [`mc-harness.project=${p.project}`, ...(all ? [] : [`mc-harness.pod=${p.pod}`])];
  let n = 0;
  for (const kind of ['container', 'volume', 'network'] as const) {
    const list = ids(d, kind, filters);
    if (list.length === 0) continue;
    must(d, kind === 'container' ? ['rm', '-f', ...list] : [kind, 'rm', ...list]);
    n += list.length;
  }
  if (all) {
    const imgs = must(d, ['image', 'ls', '-q', '--filter', `label=mc-harness.project=${p.project}`]).split('\n').filter(Boolean);
    if (imgs.length > 0) must(d, ['image', 'rm', '-f', ...new Set(imgs)]);
    n += new Set(imgs).size;
  }
  return n;
}

export function state(d: Docker, container: string): string | null {
  const r = d(['inspect', '--format', '{{.State.Status}}', container]);
  return r.status === 0 ? r.stdout.trim() : null;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Wait for "Done (Ns)!" in the log since `since` (unix seconds). On timeout or
// exit, copy latest.log into the pod's directory and fail. Returns N.
export function waitDone(p: Pod, d: Docker, since: number, timeoutS: number): number {
  const n = names(p);
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const log = d(['logs', '--since', since.toFixed(3), n.server]);
    const m = /Done \(([\d.,]+)s\)!/.exec(log.stdout + log.stderr);
    if (m) return Number(m[1].replace(',', '.'));
    const st = state(d, n.server);
    if (st !== 'running' || Date.now() > deadline) {
      privateDir(n.dir);
      const saved = join(n.dir, `latest-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      const cp = d(['cp', `${n.server}:/server/logs/latest.log`, saved]);
      if (cp.status === 0) chmodSync(saved, 0o600);
      const tail = (log.stdout + log.stderr).trim().split('\n').slice(-15).join('\n');
      fail(`${st === 'running' ? `no "Done" within ${timeoutS}s` : `server ${st ?? 'missing'}`}${cp.status === 0 ? `; log saved to ${saved}` : ''}\n${tail}`);
    }
    sleep(1000);
  }
}

export type BootReport = { done: number | null; enabled: string[]; failed: { plugin: string; line: string }[]; errors: string[] };

// Read a server's latest.log: boot time, plugins enabled, plugins that failed
// to load or enable, and ERROR lines.
export function parseBootReport(log: string): BootReport {
  const r: BootReport = { done: null, enabled: [], failed: [], errors: [] };
  for (const line of log.split('\n')) {
    const done = /Done \(([\d.,]+)s\)!/.exec(line);
    if (done && r.done === null) r.done = Number(done[1].replace(',', '.'));
    const en = /\]: \[[^\]]+\] Enabling (\S+)/.exec(line);
    if (en && !r.enabled.includes(en[1])) r.enabled.push(en[1]);
    const bad = /Error occurred while enabling (\S+)/.exec(line) ?? /Could not load '(?:.*\/)?([^/']+?)\.jar'/.exec(line) ?? /Could not load plugin '(?:.*\/)?([^/']+?)\.jar'/.exec(line);
    if (bad) r.failed.push({ plugin: bad[1], line: line.trim() });
    else if (/[ /](ERROR|SEVERE)\]:/.test(line)) r.errors.push(line.trim());
  }
  return r;
}

export function formatBootReport(r: BootReport): string {
  const out = [`done: ${r.done === null ? 'not reached' : `${r.done}s`}`, `plugins enabled: ${r.enabled.length}${r.enabled.length ? ` (${r.enabled.join(', ')})` : ''}`];
  out.push(`plugins failed: ${r.failed.length}`, ...r.failed.map((f) => `  ${f.plugin}: ${f.line}`));
  out.push(`errors: ${r.errors.length}`, ...r.errors.slice(0, 20).map((e) => `  ${e}`));
  return out.join('\n');
}

export type PodFile = { fixtures: string[] };

export function readPodFile(p: Pod): PodFile {
  const f = join(names(p).dir, 'pod.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as PodFile) : { fixtures: [] };
}
