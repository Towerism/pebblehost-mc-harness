// bin/dev: run the server tree as an isolated, offline dev pod.
// Exit 0 ok, 2 refused or failed. Never prompts.
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DevError, docker as d, fail, must } from './docker.ts';
import { build, buildRelay, chooseJar, dirtyServer, HARNESS_ROOT, labels, privateDir, pruneImages, source } from './image.ts';
import { bootTimeout, createJoin, createPod, formatBootReport, markExplored, mergeFixtures, names, parseBootReport, podOf, readBoots, readPodFile, recordBoot, relayRequest, removePod, SOCAT_IMAGE, state, waitDone, type Pod, type PodFile } from './pod.ts';

const USAGE = `usage: dev <command> [--pod ID] [options]

  up [--fixtures DIR]... [--jar NAME] [--heap SIZE]
                          build mc-dev:<imageHash> from the committed server/
                          and boot the pod; refuses uncommitted server/ changes
  rebuild [same options]  rebuild from HEAD, then recreate container and volume
  restart                 restart the container on the same image; state kept
  reset                   re-apply /fixtures on the next boot, then restart
  down [--all]            remove the pod (--all: every pod of this checkout)
  status                  list this checkout's pods
  logs [-f] [--tail N]    server console output
  boot-report [--against LOG]
                          boot time, plugins enabled and failed, ERROR lines;
                          compared with LOG (default server/logs/latest.log)
  join [--port N] [--stop]
                          proxy 127.0.0.1:N (default 25565) to the server
  console <command...>    run a server command over RCON through the pod's
                          relay and print its reply

console and join mark the pod's volume explored: a red run on it no longer
counts for the gate (bin/check run --fresh makes a new one).

--pod defaults to dev. --jar picks the server jar when server/ has several
at its root; --heap sets -Xms/-Xmx (both are kept for rebuild). --timeout S
bounds each boot (default 3x the median of the pod's last boots, or 600s).
server/ comes from $MC_HOME (default: the harness root): git archive of HEAD
when server/ is tracked, else a plain copy. Exit codes: 0 ok, 2 error.`;

type Opts = { words: string[]; pod: string; fixtures: string[]; timeout?: number; port: number; all: boolean; follow: boolean; tail?: string; stop: boolean; jar?: string; heap?: string; against?: string };

function parse(argv: string[]): { cmd: string; o: Opts } {
  const o: Opts = { words: [], pod: 'dev', fixtures: [], port: 25565, all: false, follow: false, stop: false };
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') fail(USAGE);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i] ?? fail(`${a} needs a value\n${USAGE}`);
    // console: options first; the first other word (or what follows --)
    // starts the server command, kept verbatim.
    if (cmd === 'console' && (a === '--' || !a.startsWith('-'))) {
      o.words = rest.slice(a === '--' ? i + 1 : i);
      break;
    }
    if (a === '--pod') o.pod = val();
    else if (a === '--fixtures') o.fixtures.push(resolve(val()));
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--port') o.port = Number(val());
    else if (a === '--tail') o.tail = val();
    else if (a === '--jar') o.jar = val();
    else if (a === '--heap') o.heap = val();
    else if (a === '--against') o.against = resolve(val());
    else if (a === '--all') o.all = true;
    else if (a === '-f' || a === '--follow') o.follow = true;
    else if (a === '--stop') o.stop = true;
    else fail(`unexpected argument ${a}\n${USAGE}`);
  }
  if ((o.timeout !== undefined && !(o.timeout > 0)) || !Number.isInteger(o.port)) fail(`bad --timeout or --port\n${USAGE}`);
  if (o.heap !== undefined && !/^\d+[MmGg]$/.test(o.heap)) fail(`bad --heap ${o.heap}: use e.g. 4G or 512M`);
  return { cmd, o };
}

const say = (msg: string) => process.stdout.write(`${msg}\n`);

function refuseDirty(root: string) {
  const src = source(root);
  const dirty = dirtyServer(src);
  if (dirty.length > 0) fail(`server/ has uncommitted changes; images are built from the committed tree, so commit them first:\n${dirty.join('\n')}`);
  return src;
}

// The server container's volume generation, as labelled at create.
function generation(p: Pod): string {
  return labels(d, names(p).server)['mc-harness.generation'] ?? '';
}

function requireServer(p: Pod): string {
  const n = names(p);
  if (state(d, n.server) === null) fail(`pod ${p.pod} is not up; run bin/dev up`);
  return n.server;
}

// Build first; only then replace the old pod (rebuild), so a failed build
// leaves it running. Then create the pod on a new volume generation (fresh:
// made by bin/check run --fresh), wait for "Done" and drop the project's
// images no container uses any more.
export function boot(p: Pod, pf: PodFile, timeout: number | undefined, replace: boolean, fresh = false) {
  const src = refuseDirty(p.root);
  const jar = chooseJar(src, pf.jar);
  const t0 = Date.now();
  const built = build(src, d, p.project);
  const relayTag = buildRelay(d, p.project, p.root);
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  say(built.cacheHit ? `image: cache hit ${built.tag}` : `image: built ${built.tag} in ${took}s (jar layer ${built.jarLayerCached ? 'cached' : 'rebuilt'})`);
  for (const note of built.notes) say(`override: ${note}`);
  const n = names(p);
  for (const dir of [join(p.root, '.dev'), join(p.root, '.dev', 'pods'), n.dir]) privateDir(dir);
  const fixturesHash = mergeFixtures(pf.fixtures, join(n.dir, 'fixtures'));
  if (replace) removePod(p, false, d);
  writeFileSync(join(n.dir, 'pod.json'), `${JSON.stringify(pf)}\n`, { mode: 0o600 });
  chmodSync(join(n.dir, 'pod.json'), 0o600);
  const since = Date.now() / 1000;
  const javaOpts = process.env.MC_JAVA_OPTS || (pf.heap ? `-Xms${pf.heap} -Xmx${pf.heap}` : undefined);
  const spec = { tag: built.tag, relayTag, jar, fixtures: join(n.dir, 'fixtures'), fixturesHash, rconPassword: randomBytes(18).toString('base64url'), generation: randomUUID(), fresh, javaOpts, memory: process.env.MC_DEV_MEMORY };
  createPod(p, spec, d);
  const secs = waitBoot(p, since, timeout);
  const pruned = pruneImages(d, p.project, [built.tag, relayTag]);
  const from = built.id.source === 'archive' ? `commit ${built.id.commit}` : 'plain server/ copy, not a commit';
  say(`up: pod ${p.pod} done in ${secs}s (${from}, ${jar}, image ${built.id.image.slice(0, 12)}${pruned ? `, ${pruned} old image(s) removed` : ''})`);
}

// waitDone with the timeout given or derived from the pod's boot history;
// records the boot's wall time.
function waitBoot(p: Pod, since: number, timeout: number | undefined): number {
  const secs = waitDone(p, d, since, timeout ?? bootTimeout(readBoots(p)));
  recordBoot(p, Date.now() / 1000 - since);
  return secs;
}

// Options given on the command line win over the pod's saved ones.
function podFile(p: Pod, o: Opts, saved: boolean): PodFile {
  const prev = saved ? readPodFile(p) : { fixtures: [] };
  return { fixtures: o.fixtures.length > 0 ? o.fixtures : prev.fixtures, jar: o.jar ?? prev.jar, heap: o.heap ?? prev.heap };
}

function main(argv: string[]) {
  const { cmd, o } = parse(argv);
  const root = resolve(process.env.MC_HOME || HARNESS_ROOT);
  const p = podOf(root, o.pod);
  const n = names(p);
  switch (cmd) {
    case 'up': {
      const st = state(d, n.server);
      if (st !== null) {
        const commit = labels(d, n.server)['mc-harness.commit'];
        fail(`pod ${p.pod} already exists (${st}, commit ${commit}); use bin/dev restart, rebuild or down`);
      }
      boot(p, podFile(p, o, false), o.timeout, false);
      break;
    }
    case 'rebuild':
      boot(p, podFile(p, o, true), o.timeout, true);
      break;
    case 'restart':
    case 'reset': {
      const server = requireServer(p);
      if (cmd === 'reset') must(d, ['exec', server, 'rm', '-f', '/server/.mc-harness-seeded']);
      const since = Date.now() / 1000;
      must(d, ['restart', '-t', '60', server]);
      say(`${cmd}: pod ${p.pod} done in ${waitBoot(p, since, o.timeout)}s`);
      break;
    }
    case 'down':
      say(`down: removed ${removePod(p, o.all, d)} resource(s)`);
      break;
    case 'status': {
      const out = must(d, ['ps', '-a', '--filter', `label=mc-harness.project=${p.project}`, '--format', '{{.Label "mc-harness.pod"}}\t{{.State}}\t{{.Label "mc-harness.commit"}}\t{{.Names}}']);
      say(out.trim() ? `POD\tSTATE\tCOMMIT\tCONTAINER\n${out.trim()}` : 'no pods');
      break;
    }
    case 'logs': {
      const args = ['logs', ...(o.follow ? ['-f'] : []), ...(o.tail ? ['--tail', o.tail] : []), requireServer(p)];
      process.exitCode = d(args, { inherit: true }).status === 0 ? 0 : 2;
      break;
    }
    case 'boot-report': {
      const dev = parseBootReport(must(d, ['exec', requireServer(p), 'cat', '/server/logs/latest.log']));
      const against = o.against ?? join(root, 'server', 'logs', 'latest.log');
      if (o.against && !existsSync(against)) fail(`no log at ${against}`);
      say(formatBootReport(dev, existsSync(against) ? parseBootReport(readFileSync(against, 'utf8')) : undefined));
      break;
    }
    case 'join': {
      if (o.stop) {
        d(['rm', '-f', n.join]);
        d(['network', 'rm', n.joinNet]);
        say('join: proxy stopped');
        break;
      }
      requireServer(p);
      if (state(d, n.join) !== null) fail(`join proxy already running; bin/dev join --stop first`);
      markExplored(p, generation(p));
      createJoin(p, o.port, SOCAT_IMAGE, d);
      say(`join: connect to 127.0.0.1:${o.port}`);
      break;
    }
    case 'console': {
      const command = o.words.join(' ');
      if (command.trim() === '') fail(`console needs a server command\n${USAGE}`);
      const st = state(d, requireServer(p));
      if (st !== 'running') fail(`server of pod ${p.pod} is ${st}; run bin/dev restart`);
      markExplored(p, generation(p));
      const { reply } = relayRequest(p, d, { op: 'console', command });
      if (typeof reply !== 'string') fail('relay reply without output');
      process.stdout.write(reply === '' || reply.endsWith('\n') ? reply : `${reply}\n`);
      break;
    }
    default:
      fail(`unknown command ${cmd}\n${USAGE}`);
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof DevError)) throw e;
    process.stderr.write(`dev: ${e.message}\n`);
    process.exit(2);
  }
}
