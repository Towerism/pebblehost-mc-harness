// A pod: one server container on its own internal network (no gateway, so no
// egress), a named volume at /server and a read-only /fixtures, plus the relay
// container (src/relay/) on that network only, which holds the RCON connection. Everything
// carries the labels mc-harness.project and mc-harness.pod, which down uses.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail, must, type Docker } from './docker.ts';
import { dirHash, privateDir, walk } from './image.ts';

export const SOCAT_IMAGE = 'alpine/socat@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed';
export const MARKER = '/server/.mc-harness-seeded';

// Update, metrics and download hosts plugins call at boot. The pod has no
// route out anyway; pointing them at 127.0.0.1 makes each call fail at once
// (connection refused) instead of waiting on a DNS timeout.
export const EGRESS_SINKS = [
  'bstats.org',
  'api.spigotmc.org',
  'www.spigotmc.org',
  'api.spiget.org',
  'api.modrinth.com',
  'cdn.modrinth.com',
  'hangar.papermc.io',
  'api.papermc.io',
  'fill.papermc.io',
  'api.purpurmc.org',
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'api.polymart.org',
  'api.curseforge.com',
  'dev.bukkit.org',
  'servermods.forgesvc.net',
  'ci.codemc.io',
  'repo.codemc.io',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'api.mojang.com',
  'sessionserver.mojang.com',
  'api.minecraftservices.com',
  'piston-meta.mojang.com',
  'textures.minecraft.net',
  'api.luckperms.net',
  'metadata.luckperms.net',
  'bytebin.lucko.me',
  'spark.lucko.me',
  'api.viaversion.com',
  'grim.ac',
  'api.extendedclip.com',
  'update.citizensnpcs.co',
  'api.crazycrew.us',
];

export type Pod = { root: string; project: string; pod: string };

export function podOf(root: string, pod: string): Pod {
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(pod)) fail(`bad pod name ${pod}: use a-z, 0-9, _ and -`);
  return { root, pod, project: createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 8) };
}

export function names(p: Pod) {
  const prefix = `mc-${p.project}-${p.pod}`;
  return { net: `${prefix}-net`, vol: `${prefix}-server`, server: `${prefix}-server`, relay: `${prefix}-relay`, join: `${prefix}-join`, joinNet: `${prefix}-joinnet`, dir: join(p.root, '.dev', 'pods', p.pod) };
}

function labelArgs(p: Pod): string[] {
  return ['--label', `mc-harness.project=${p.project}`, '--label', `mc-harness.pod=${p.pod}`];
}

// Merge fixture directories into dest; the same path from two sources with
// different content is refused. Then build each sqlite target (server path ->
// SQL file) as a new database; a target that is also a fixture file is
// refused. Returns the fixtures hash: the merged files' hash, extended by
// each target and its SQL bytes (not the built bytes) when there are any.
export function mergeFixtures(sources: string[], dest: string, sqlite: Record<string, string> = {}): string {
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
  const files = dirHash(dest);
  const targets = Object.keys(sqlite).sort();
  if (targets.length === 0) return files;
  const h = createHash('sha256').update(`${files}\n`);
  for (const target of targets) {
    const sql = sqlite[target];
    const prev = from.get(target);
    if (prev !== undefined) fail(`fixture conflict: ${target} is both a file in ${prev} and built from ${sql}`);
    const text = readFileSync(sql);
    h.update(`sqlite ${target} ${createHash('sha256').update(text).digest('hex')}\n`);
    try {
      mkdirSync(dirname(join(dest, target)), { recursive: true });
      const db = new DatabaseSync(join(dest, target));
      try {
        db.exec(text.toString('utf8'));
      } finally {
        db.close();
      }
    } catch (e) {
      fail(`sqlite fixture ${sql}: ${(e as Error).message}`);
    }
  }
  return h.digest('hex');
}

// generation: a new id for each new volume; fresh: made by bin/check run
// --fresh. Both are labels on the volume and the server container. commit
// and source are the checkout this boot came from: on the container they
// override the image's, which name whichever commit first built that tree.
export type Spec = { tag: string; relayTag: string; jar: string; fixtures: string; fixturesHash: string; rconPassword: string; generation: string; fresh: boolean; commit: string; source: string; javaOpts?: string; memory?: string };

// Network, volume, server and relay. No published port: bin/dev join adds a
// proxy. The RCON password reaches docker through its environment, never argv.
export function createPod(p: Pod, s: Spec, d: Docker): void {
  const n = names(p);
  must(d, ['network', 'create', '--internal', '--ipv6=false', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labelArgs(p), n.net]);
  const gen = ['--label', `mc-harness.generation=${s.generation}`, '--label', `mc-harness.fresh=${s.fresh}`];
  must(d, ['volume', 'create', ...labelArgs(p), ...gen, n.vol]);
  const run = ['run', '-d', '--name', n.server, '--hostname', `mc-${p.pod}`, '--network', n.net, ...labelArgs(p)];
  run.push('--label', `mc-harness.fixtures=${s.fixturesHash}`, ...gen, '--label', `mc-harness.commit=${s.commit}`, '--label', `mc-harness.source=${s.source}`);
  run.push('-v', `${n.vol}:/server`, '-v', `${s.fixtures}:/fixtures:ro`, '-e', 'RCON_PASSWORD', '-e', `MC_JAR=${s.jar}`);
  for (const host of EGRESS_SINKS) run.push('--add-host', `${host}:127.0.0.1`);
  if (s.javaOpts) run.push('-e', `JAVA_OPTS=${s.javaOpts}`);
  if (s.memory) run.push('--memory', s.memory);
  run.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '4096', '--stop-timeout', '60', s.tag);
  must(d, run, { RCON_PASSWORD: s.rconPassword });
  const relay = ['run', '-d', '--name', n.relay, '--hostname', `relay-${p.pod}`, '--network', n.net, ...labelArgs(p), '--init'];
  relay.push('-e', 'RCON_PASSWORD', '-e', `RCON_HOST=${n.server}`, '--user', '1000:1000', '--read-only', '--tmpfs', '/run:rw,nosuid,nodev,noexec,size=1m,uid=1000,gid=1000,mode=0700', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000,mode=0700');
  relay.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', s.relayTag);
  must(d, relay, { RCON_PASSWORD: s.rconPassword });
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

// Send one request to the pod's relay daemon (src/relay/) and return its
// reply; fails with the relay's reason when the reply is not ok.
export function relayRequest(p: Pod, d: Docker, req: { op: string } & Record<string, unknown>): Record<string, unknown> {
  const n = names(p);
  const st = state(d, n.relay);
  if (st !== 'running') fail(`relay of pod ${p.pod} is ${st ?? 'missing'}; bin/dev rebuild recreates it`);
  const r = d(['exec', '-i', n.relay, 'node', '/relay/client.ts'], { input: `${JSON.stringify(req)}\n` });
  let reply: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    reply = JSON.parse(r.stdout);
  } catch {
    fail(`relay gave no reply: ${(r.stderr || r.stdout).trim()}`);
  }
  if (reply.ok !== true) fail(reply.error ?? `relay reply not ok: ${r.stdout.trim()}`);
  return reply;
}

// A volume a human touched (bin/dev console, join) carries this marker, so
// its runs don't count for the gate (G9). It lives in the volume itself:
// it goes with the volume (rebuild, --fresh) and survives restart, reset and
// a deleted .dev/.
export const EXPLORED = '/server/.mc-harness-explored';

export function markExplored(p: Pod, d: Docker): void {
  must(d, ['exec', names(p).server, 'touch', EXPLORED]);
}

export function isExplored(p: Pod, d: Docker): boolean {
  return d(['exec', names(p).server, 'test', '-e', EXPLORED]).status === 0;
}

// bin/check suite runs the suite in a detached child (its own process
// group) and records the group here, so a later suite or bin/dev down --all
// can stop one whose parent died (SIGKILL) and left it running.
export function suitePidFile(root: string): string {
  return join(root, '.dev', 'suite.pid');
}

// Kill the recorded suite child's process group, if it is still that child:
// /proc/<pid>/environ must hold MC_SUITE_CHILD=1 and this project's MC_HOME,
// so a reused pid is never touched. Returns whether it killed one.
export function killOrphanSuite(root: string): boolean {
  const f = suitePidFile(root);
  if (!existsSync(f)) return false;
  const pid = Number(readFileSync(f, 'utf8').trim());
  rmSync(f, { force: true });
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let env: string[];
  try {
    env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch {
    return false;
  }
  if (!env.includes('MC_SUITE_CHILD=1') || !env.includes(`MC_HOME=${root}`)) return false;
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

// Restart the server container on its volume and wait for "Done"; with
// reset, drop the seeded marker first so /fixtures is applied again.
// Returns the boot's "Done" seconds.
export function restartServer(p: Pod, d: Docker, reset: boolean): number {
  const server = names(p).server;
  if (reset) must(d, ['exec', server, 'rm', '-f', MARKER]);
  const since = Date.now() / 1000;
  must(d, ['restart', '-t', '60', server]);
  return waitDone(p, d, since, bootTimeout(readBoots(p)));
}

// Every bin/check run on a volume appends a line here; the gate counts only
// a red or green that was the first run on its volume, so no other check
// can have changed the server before it.
export const RUN_LOG = '/server/.mc-harness-runs';

// Append `line nonce` to the volume's run log in one O_APPEND write (no
// read-then-write race); returns the nonce.
export function logRun(p: Pod, d: Docker, line: string): string {
  const nonce = randomUUID();
  const r = d(['exec', '-i', names(p).server, 'sh', '-c', `cat >>${RUN_LOG}`], { input: `${line} ${nonce}\n` });
  if (r.status !== 0) fail(`cannot append to ${RUN_LOG}: ${r.stderr.trim()}`);
  return nonce;
}

// Where the run's line sits in the log (-1: gone) and how many lines came
// after it: read once the run is over, so a parallel run shows either way.
export function runPosition(p: Pod, d: Docker, nonce: string): { index: number; after: number } {
  const r = d(['exec', names(p).server, 'cat', RUN_LOG]);
  const lines = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  const index = lines.findIndex((l) => l.endsWith(` ${nonce}`));
  return { index, after: index < 0 ? 0 : lines.length - index - 1 };
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

// The server's own ready line. Plugins print "Done (Ns)!" too, so the match
// needs the "]: " prefix and the "For help" that follows.
export const DONE = /\]: Done \(([\d.,]+)s\)! For help/;

// Wait for the server's "Done (Ns)!" in the log since `since` (unix seconds). On timeout or
// exit, copy latest.log into the pod's directory and fail. Returns N.
export function waitDone(p: Pod, d: Docker, since: number, timeoutS: number): number {
  const n = names(p);
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const log = d(['logs', '--since', since.toFixed(3), n.server]);
    const m = DONE.exec(log.stdout + log.stderr);
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

export type BootReport = { done: number | null; enabled: string[]; failed: { plugin: string; line: string; cause: string }[]; errors: string[]; noise: number };

// ERROR lines expected from any offline pod: auth key fetches, update and
// version checks, SLF4J's no-provider notice.
export const OFFLINE_NOISE = [/yggdrasil|publickeys/i, /SLF4J/, /update ?check|check(ing)? for (an? )?updates?|latest (build|release|version)/i];

// Read a server's latest.log: boot time, plugins enabled, plugins that failed
// to load or enable, and ERROR lines.
export function parseBootReport(log: string): BootReport {
  const r: BootReport = { done: null, enabled: [], failed: [], errors: [], noise: 0 };
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const done = DONE.exec(line);
    if (done && r.done === null) r.done = Number(done[1].replace(',', '.'));
    // "Enabling <Name> v<version>" only: plugins also log "Enabling x...".
    const en = /\]: \[[^\]]+\] Enabling (\S+) v\d/.exec(line);
    if (en && !r.enabled.includes(en[1])) r.enabled.push(en[1]);
    const bad = /Error occurred while enabling (\S+)/.exec(line) ?? /Could not load '(?:.*\/)?([^/']+?)\.jar'/.exec(line) ?? /Could not load plugin '(?:.*\/)?([^/']+?)\.jar'/.exec(line);
    if (bad) {
      r.failed.push({ plugin: bad[1], line: line.trim(), cause: cause(lines, i) });
      // "Enabling X" comes before the failure: X did not end up enabled.
      r.enabled = r.enabled.filter((e) => e.toLowerCase() !== bad[1].toLowerCase());
    }
    else if (/[ /](ERROR|SEVERE)\]:/.test(line)) {
      if (OFFLINE_NOISE.some((re) => re.test(line))) r.noise++;
      else r.errors.push(line.trim());
    }
  }
  return r;
}

// The first "Caused by:" of the stack trace after line i, else its first line.
function cause(lines: string[], i: number): string {
  const trace: string[] = [];
  for (let j = i + 1; j < lines.length && !/^\[\d/.test(lines[j]); j++) trace.push(lines[j].trim());
  return trace.find((l) => l.startsWith('Caused by:')) ?? trace.find(Boolean) ?? lines[i].trim();
}

// With `live` (the live server's latest.log), compare the plugins enabled:
// N/M, each one live enabled and dev did not, with its dev error line, and
// any the dev pod enabled that live did not.
export function formatBootReport(r: BootReport, live?: BootReport): string {
  const out = [`done: ${r.done === null ? 'not reached' : `${r.done}s`}${live?.done != null ? ` (live: ${live.done}s)` : ''}`];
  if (live) {
    const lower = new Set(r.enabled.map((e) => e.toLowerCase()));
    const missing = live.enabled.filter((e) => !lower.has(e.toLowerCase()));
    const liveLower = new Set(live.enabled.map((e) => e.toLowerCase()));
    out.push(`plugins enabled: ${live.enabled.length - missing.length}/${live.enabled.length} of live`);
    for (const m of missing) {
      const line = r.failed.find((f) => f.plugin.toLowerCase() === m.toLowerCase())?.cause ?? r.errors.find((e) => e.toLowerCase().includes(m.toLowerCase()));
      out.push(`  not enabled: ${m}: ${line ?? 'no error line names it'}`);
    }
    for (const extra of r.enabled.filter((e) => !liveLower.has(e.toLowerCase()))) out.push(`  enabled on dev only: ${extra}`);
  } else {
    out.push(`plugins enabled: ${r.enabled.length}${r.enabled.length ? ` (${r.enabled.join(', ')})` : ''}`);
  }
  out.push(`plugins failed: ${r.failed.length}`, ...r.failed.map((f) => `  ${f.plugin}: ${f.cause}`));
  out.push(`errors: ${r.errors.length}`, ...r.errors.slice(0, 20).map((e) => `  ${e}`));
  out.push(`offline noise: ${r.noise} (auth key fetch, update checks, SLF4J)`);
  return out.join('\n');
}

// Boot wall times of the pod's last successful boots, newest last.
export function readBoots(p: Pod): number[] {
  const f = join(names(p).dir, 'boots.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as number[]) : [];
}

export function recordBoot(p: Pod, seconds: number): void {
  const f = join(names(p).dir, 'boots.json');
  writeFileSync(f, `${JSON.stringify([...readBoots(p), Math.round(seconds * 10) / 10].slice(-5))}\n`, { mode: 0o600 });
}

// 3x the median of the recorded boots (at least 120s); 600s before any.
export function bootTimeout(boots: number[]): number {
  if (boots.length === 0) return 600;
  const s = [...boots].sort((a, b) => a - b);
  return Math.max(120, Math.ceil(3 * s[Math.floor(s.length / 2)]));
}

export type PodFile = { fixtures: string[]; sqlite?: Record<string, string>; jar?: string; heap?: string };

export function readPodFile(p: Pod): PodFile {
  const f = join(names(p).dir, 'pod.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as PodFile) : { fixtures: [] };
}
