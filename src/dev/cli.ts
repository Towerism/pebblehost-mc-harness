// bin/dev: run the server tree as an isolated, offline dev pod.
// Exit 0 ok, 2 refused or failed. Never prompts.
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DevError, docker as d, fail, must } from './docker.ts';
import { build, dirtyServer, HARNESS_ROOT, labels, privateDir, pruneImages, source } from './image.ts';
import { createJoin, createPod, formatBootReport, mergeFixtures, names, parseBootReport, podOf, readPodFile, removePod, SOCAT_IMAGE, state, waitDone, type Pod, type PodFile } from './pod.ts';

const USAGE = `usage: dev <command> [--pod ID] [options]

  up [--fixtures DIR]...  build mc-dev:<imageHash> from the committed server/
                          and boot the pod; refuses uncommitted server/ changes
  rebuild [--fixtures DIR]...
                          rebuild from HEAD, then recreate container and volume
  restart                 restart the container on the same image; state kept
  reset                   re-apply /fixtures on the next boot, then restart
  down [--all]            remove the pod (--all: every pod of this checkout)
  status                  list this checkout's pods
  logs [-f] [--tail N]    server console output
  boot-report             boot time, plugins enabled and failed, ERROR lines
  join [--port N] [--stop]
                          proxy 127.0.0.1:N (default 25565) to the server

--pod defaults to dev. --timeout S (default 300) bounds each boot.
server/ comes from $MC_HOME (default: the harness root): git archive of HEAD
when server/ is tracked, else a plain copy. Exit codes: 0 ok, 2 error.`;

type Opts = { pod: string; fixtures: string[]; timeout: number; port: number; all: boolean; follow: boolean; tail?: string; stop: boolean };

function parse(argv: string[]): { cmd: string; o: Opts } {
  const o: Opts = { pod: 'dev', fixtures: [], timeout: 300, port: 25565, all: false, follow: false, stop: false };
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') fail(USAGE);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i] ?? fail(`${a} needs a value\n${USAGE}`);
    if (a === '--pod') o.pod = val();
    else if (a === '--fixtures') o.fixtures.push(resolve(val()));
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--port') o.port = Number(val());
    else if (a === '--tail') o.tail = val();
    else if (a === '--all') o.all = true;
    else if (a === '-f' || a === '--follow') o.follow = true;
    else if (a === '--stop') o.stop = true;
    else fail(`unexpected argument ${a}\n${USAGE}`);
  }
  if (!(o.timeout > 0) || !Number.isInteger(o.port)) fail(`bad --timeout or --port\n${USAGE}`);
  return { cmd, o };
}

const say = (msg: string) => process.stdout.write(`${msg}\n`);

function refuseDirty(root: string) {
  const src = source(root);
  const dirty = dirtyServer(src);
  if (dirty.length > 0) fail(`server/ has uncommitted changes; images are built from the committed tree, so commit them first:\n${dirty.join('\n')}`);
  return src;
}

function requireServer(p: Pod): string {
  const n = names(p);
  if (state(d, n.server) === null) fail(`pod ${p.pod} is not up; run bin/dev up`);
  return n.server;
}

// Build first; only then replace the old pod (rebuild), so a failed build
// leaves it running. Then create the pod, wait for "Done" and drop the
// project's images no container uses any more.
function boot(p: Pod, pf: PodFile, timeout: number, replace: boolean) {
  const src = refuseDirty(p.root);
  const built = build(src, d, p.project);
  say(built.cacheHit ? `image: cache hit ${built.tag}` : `image: built ${built.tag} (jar layer ${built.jarLayerCached ? 'cached' : 'rebuilt'})`);
  for (const note of built.notes) say(`override: ${note}`);
  const n = names(p);
  for (const dir of [join(p.root, '.dev'), join(p.root, '.dev', 'pods'), n.dir]) privateDir(dir);
  const fixturesHash = mergeFixtures(pf.fixtures, join(n.dir, 'fixtures'));
  if (replace) removePod(p, false, d);
  writeFileSync(join(n.dir, 'pod.json'), `${JSON.stringify(pf)}\n`, { mode: 0o600 });
  chmodSync(join(n.dir, 'pod.json'), 0o600);
  const since = Date.now() / 1000;
  const spec = { tag: built.tag, fixtures: join(n.dir, 'fixtures'), fixturesHash, rconPassword: randomBytes(18).toString('base64url'), javaOpts: process.env.MC_JAVA_OPTS, memory: process.env.MC_DEV_MEMORY };
  createPod(p, spec, d);
  const secs = waitDone(p, d, since, timeout);
  const pruned = pruneImages(d, p.project, [built.tag]);
  const from = built.id.source === 'archive' ? `commit ${built.id.commit}` : 'plain server/ copy, not a commit';
  say(`up: pod ${p.pod} done in ${secs}s (${from}, image ${built.id.image.slice(0, 12)}${pruned ? `, ${pruned} old image(s) removed` : ''})`);
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
      boot(p, { fixtures: o.fixtures }, o.timeout, false);
      break;
    }
    case 'rebuild':
      boot(p, o.fixtures.length > 0 ? { fixtures: o.fixtures } : readPodFile(p), o.timeout, true);
      break;
    case 'restart':
    case 'reset': {
      const server = requireServer(p);
      if (cmd === 'reset') must(d, ['exec', server, 'rm', '-f', '/server/.mc-harness-seeded']);
      const since = Date.now() / 1000;
      must(d, ['restart', '-t', '60', server]);
      say(`${cmd}: pod ${p.pod} done in ${waitDone(p, d, since, o.timeout)}s`);
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
    case 'boot-report':
      say(formatBootReport(parseBootReport(must(d, ['exec', requireServer(p), 'cat', '/server/logs/latest.log']))));
      break;
    case 'join': {
      if (o.stop) {
        d(['rm', '-f', n.join]);
        d(['network', 'rm', n.joinNet]);
        say('join: proxy stopped');
        break;
      }
      requireServer(p);
      if (state(d, n.join) !== null) fail(`join proxy already running; bin/dev join --stop first`);
      createJoin(p, o.port, SOCAT_IMAGE, d);
      say(`join: connect to 127.0.0.1:${o.port}`);
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
  process.stderr.write(`dev: ${e.message}\n`);
  process.exit(2);
}
