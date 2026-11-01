// Unit tests for bin/dev (src/dev/): overrides, image identity, build context,
// pod argv against a recording fake docker, fixtures, boot report, CLI refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DevError, type Docker } from '../../src/dev/docker.ts';
import { build, buildContext, chooseJar, dirHash, HARNESS_INPUTS, HARNESS_ROOT, identity, pruneImages, source, stepCached } from '../../src/dev/image.ts';
import { applyOverrides, OVERRIDES, setProperty, setYaml } from '../../src/dev/overrides.ts';
import { bootTimeout, createJoin, createPod, EGRESS_SINKS, formatBootReport, mergeFixtures, parseBootReport, podOf, removePod } from '../../src/dev/pod.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'dev-test-'));

function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

function gitRepo(files: Record<string, string>): string {
  const root = tmp();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  write(root, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

function commitAll(root: string, files: Record<string, string>) {
  write(root, files);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  spawnSync('git', ['-C', root, 'add', '-A'], { env });
  spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'change'], { env });
}

// A docker stand-in that records argv and env, and answers from a table of
// prefixes: stdout, or { status } for a failing call.
function recorder(answers: Record<string, string | { status: number }> = {}): { d: Docker; calls: string[][]; envs: (Record<string, string> | undefined)[] } {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const d: Docker = (args, opts) => {
    calls.push(args);
    envs.push(opts?.env);
    const key = Object.keys(answers).find((k) => args.join(' ').startsWith(k));
    const a = key === undefined ? '' : answers[key];
    return typeof a === 'string' ? { status: 0, stdout: a, stderr: '' } : { status: a.status, stdout: '', stderr: 'no such object' };
  };
  return { d, calls, envs };
}

test('setProperty rewrites only the key, keeping comments and other lines', () => {
  assert.equal(setProperty('#online-mode=x\nonline-mode=true\nmotd=a=b\n', 'online-mode', 'false'), '#online-mode=x\nonline-mode=false\nmotd=a=b\n');
  assert.equal(setProperty('motd=hi\n', 'online-mode', 'false'), null);
});

test('setYaml edits one nested key, matching whole keys at the right depth only', () => {
  const yaml = ['# top', 'Misc:', '  Other:', '    Enabled: true', '  AutoUpdate:', '    # note', '    Enabled: true # inline', '    Mode: x', 'Enabled: true', ''].join('\n');
  assert.equal(setYaml(yaml, 'Misc.AutoUpdate.Enabled', 'false'), yaml.replace('    Enabled: true # inline', '    Enabled: false'));
  assert.equal(setYaml(yaml, 'Enabled', 'false'), yaml.replace(/^Enabled: true$/m, 'Enabled: false'));
  assert.equal(setYaml(yaml, 'Misc.Missing.Enabled', 'false'), null);
  assert.equal(setYaml(yaml, 'AutoUpdate', 'false'), null, 'a nested key is not a top-level one');
  assert.equal(setYaml('"check-for-updates": true\n', 'check-for-updates', 'false'), '"check-for-updates": false\n');
  assert.equal(setYaml('check-for-updates-extra: true\n', 'check-for-updates', 'false'), null);
});

// A synthetic file holding `key` (dotted) as true, between two siblings.
function synthetic(o: { file: string; key: string }): string {
  if (o.file.endsWith('.properties')) return `motd=hi\n${o.key}=true\nmax-players=5\n`;
  const segs = o.key.split('.');
  const lines = ['first: 1'];
  segs.forEach((s, i) => lines.push(`${'  '.repeat(i)}${s}:${i === segs.length - 1 ? ' true' : ''}`));
  lines.push('last: 2', '');
  return lines.join('\n');
}

for (const o of OVERRIDES) {
  test(`override sets ${o.file} ${o.key}=${o.value}`, () => {
    const cfg = tmp();
    write(cfg, { [o.file]: synthetic(o) });
    const a = applyOverrides(cfg, [o])[0];
    assert.equal(a.set, 1);
    assert.match(a.notes[0], new RegExp(`${o.key.replace(/\./g, '\\.')}=${o.value}`));
    const leaf = o.key.split('.').pop() ?? '';
    const want = o.file.endsWith('.properties') ? `${leaf}=${o.value}` : `${leaf}: ${o.value}`;
    assert.ok(a.content?.split('\n').some((l) => l.trim() === want), want);
    assert.ok(a.content?.includes('first: 1') || a.content?.includes('motd=hi'));
  });
}

test('every override in a file applies in order to one rewritten copy', () => {
  const cfg = tmp();
  write(cfg, { 'plugins/Lottery/config.yml': 'UpdateCheck: true\nMetrics: true\nPrize: 5\n' });
  const a = applyOverrides(cfg).find((x) => x.file === 'plugins/Lottery/config.yml');
  assert.equal(a?.content, 'UpdateCheck: false\nMetrics: false\nPrize: 5\n');
  assert.equal(a?.set, 2);
});

test('an override is a no-op with a note when its file or key is absent', () => {
  const all = applyOverrides(tmp());
  assert.ok(all.every((a) => a.content === null && a.set === 0));
  assert.match(all[0].notes[0], /server.properties absent/);
  const cfg = tmp();
  write(cfg, { 'server.properties': 'motd=hi\n' });
  const nokey = applyOverrides(cfg)[0];
  assert.equal(nokey.content, 'motd=hi\n');
  assert.equal(nokey.set, 0);
  assert.match(nokey.notes[0], /no online-mode key/);
});

test('treeHash ignores checks/, docs/ and .verify/; a server change moves it', () => {
  const root = gitRepo({ 'server/a.txt': 'a', 'checks/1/t.ts': 'x', 'docs/d.md': 'x', '.verify/r.jsonl': 'x' });
  const before = identity(source(root));
  commitAll(root, { 'checks/1/t.ts': 'y', 'docs/d.md': 'y', '.verify/r.jsonl': 'y' });
  const same = identity(source(root));
  assert.notEqual(same.commit, before.commit);
  assert.equal(same.tree, before.tree);
  assert.equal(same.image, before.image);
  commitAll(root, { 'server/a.txt': 'b' });
  assert.notEqual(identity(source(root)).tree, before.tree);
});

test('a harness input change moves imageHash but not treeHash', () => {
  const root = gitRepo({ 'server/a.txt': 'a' });
  const harness = tmp();
  for (const f of HARNESS_INPUTS) {
    mkdirSync(dirname(join(harness, f)), { recursive: true });
    cpSync(join(HARNESS_ROOT, f), join(harness, f));
  }
  const before = identity(source(root), harness);
  assert.equal(before.image, identity(source(root)).image);
  writeFileSync(join(harness, 'docker/entrypoint.sh'), '# changed\n', { flag: 'a' });
  const after = identity(source(root), harness);
  assert.equal(after.tree, before.tree);
  assert.notEqual(after.harness, before.harness);
  assert.notEqual(after.image, before.image);
});

test('an untracked server/ is a plain directory: source dir, no commit, dir: tree hash, symlinks refused', () => {
  const root = tmp();
  write(root, { 'server/a.txt': 'a' });
  const src = source(root);
  assert.equal(src.kind, 'dir');
  const id = identity(src);
  assert.equal(id.source, 'dir');
  assert.equal(id.commit, '');
  assert.match(id.tree, /^dir:[0-9a-f]{64}$/);
  write(root, { 'server/a.txt': 'b' });
  assert.notEqual(identity(src).tree, id.tree);
  symlinkSync('/etc/passwd', join(root, 'server/link'));
  assert.throws(() => identity(src), DevError);
});

test('source refuses a checkout without server/', () => {
  assert.throws(() => source(tmp()), /no server\//);
});

test('the build context puts jars and libraries in bin/, the rest in cfg/, overrides in ovr/', () => {
  const root = gitRepo({
    'server/purpur.jar': 'jar',
    'server/libraries/x/y.jar': 'lib',
    'server/cache/mojang.jar': 'cache',
    'server/versions/26.1.2/v.jar': 'ver',
    'server/plugins/P.JAR': 'plugin',
    'server/plugins/P/config.yml': 'k: v',
    'server/server.properties': 'online-mode=true\n',
  });
  const ctx = tmp();
  buildContext(source(root), ctx);
  for (const f of ['purpur.jar', 'libraries/x/y.jar', 'cache/mojang.jar', 'versions/26.1.2/v.jar', 'plugins/P.JAR']) assert.ok(existsSync(join(ctx, 'bin', f)), f);
  for (const f of ['plugins/P/config.yml', 'server.properties']) assert.ok(existsSync(join(ctx, 'cfg', f)), f);
  assert.equal(readFileSync(join(ctx, 'ovr/server.properties'), 'utf8'), 'online-mode=false\n');
  assert.equal(readFileSync(join(ctx, 'cfg/server.properties'), 'utf8'), 'online-mode=true\n');
  assert.ok(existsSync(join(ctx, 'Dockerfile')) && existsSync(join(ctx, 'entrypoint.sh')));
});

test('chooseJar: the only root jar, else --jar, which must be a root jar', () => {
  assert.equal(chooseJar(source(gitRepo({ 'server/purpur.jar': '1', 'server/plugins/p.jar': '2' }))), 'purpur.jar');
  const two = source(gitRepo({ 'server/a.jar': '1', 'server/b.jar': '2' }));
  assert.throws(() => chooseJar(two), /2 root jars \(a\.jar, b\.jar\); pick one with --jar NAME/);
  assert.equal(chooseJar(two, 'b.jar'), 'b.jar');
  assert.throws(() => chooseJar(two, 'plugins/p.jar'), /not a jar at the server\/ root/);
  assert.throws(() => chooseJar(source(gitRepo({ 'server/x.yml': '1' }))), /no \*\.jar at its root/);
  const dir = tmp();
  write(dir, { 'server/a.jar': '1', 'server/c.jar': '2' });
  assert.equal(chooseJar(source(dir), 'c.jar'), 'c.jar');
});

test('the build context refuses committed symlinks', () => {
  const root = gitRepo({ 'server/a.jar': '1' });
  symlinkSync('/etc/passwd', join(root, 'server/link'));
  commitAll(root, {});
  assert.throws(() => buildContext(source(root), tmp()), /symlinks refused.*server\/link/);
});

test('stepCached reads classic and BuildKit output', () => {
  const step = 'COPY --chown=1000:1000 bin ';
  assert.ok(stepCached('Step 3/9 : COPY --chown=1000:1000 bin /server/\n ---> Using cache\n ---> 1a2b\n', step));
  assert.ok(!stepCached('Step 3/9 : COPY --chown=1000:1000 bin /server/\n ---> 1a2b\nStep 4/9 : COPY x\n ---> Using cache\n', step));
  assert.ok(stepCached('#7 [3/6] COPY --chown=1000:1000 bin /server/\n#7 CACHED\n', step));
  assert.ok(!stepCached('#7 [3/6] COPY --chown=1000:1000 bin /server/\n#7 DONE 1.2s\n#8 CACHED\n', step));
});

test('build labels an archive image with its commit and source=archive', () => {
  const root = gitRepo({ 'server/a.jar': '1' });
  const { d, calls } = recorder({ 'image inspect': { status: 1 } });
  const built = build(source(root), d, 'proj1234');
  const args = calls.find((c) => c[0] === 'build') ?? [];
  assert.ok(args.includes('mc-harness.source=archive'));
  assert.equal(built.id.commit.length, 40);
  for (const k of ['commit', 'tree', 'harness', 'image'] as const) assert.ok(args.includes(`mc-harness.${k}=${built.id[k]}`), k);
  assert.ok(args.includes('mc-harness.project=proj1234'));
});

test('build labels a plain-copy image source=dir with an empty commit and a dir: tree', () => {
  const root = tmp();
  write(root, { 'server/a.jar': '1' });
  const { d, calls } = recorder({ 'image inspect': { status: 1 } });
  build(source(root), d, 'proj1234');
  const args = calls.find((c) => c[0] === 'build') ?? [];
  assert.ok(args.includes('mc-harness.source=dir'));
  assert.ok(args.includes('mc-harness.commit='));
  assert.ok(args.some((a) => /^mc-harness\.tree=dir:[0-9a-f]{64}$/.test(a)));
  // .dev is owner-only, and the build context is gone after the build.
  assert.equal(statSync(join(root, '.dev')).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(root, '.dev')), []);
});

test('pruneImages keeps the new image and images a container uses', () => {
  const { d, calls } = recorder({
    'ps -a': 'mc-dev:inuse\n',
    'image ls': 'mc-dev:new id1\nmc-dev:inuse id2\nmc-dev:old id3\nother:tag id4\n',
  });
  assert.equal(pruneImages(d, 'proj1234', ['mc-dev:new']), 1);
  assert.deepEqual(calls[2], ['image', 'rm', '-f', 'mc-dev:old']);
  assert.ok(calls[1].includes('label=mc-harness.project=proj1234'));
});

test('createPod: internal IPv4-only network without a gateway, labelled volume, no published port', () => {
  const p = podOf(tmp(), 'dev');
  const { d, calls, envs } = recorder();
  createPod(p, { tag: 'mc-dev:abc', jar: 'purpur.jar', fixtures: '/fx', fixturesHash: 'f00', rconPassword: 'pw' }, d);
  const labels = ['--label', `mc-harness.project=${p.project}`, '--label', 'mc-harness.pod=dev'];
  const prefix = `mc-${p.project}-dev`;
  assert.deepEqual(calls[0], ['network', 'create', '--internal', '--ipv6=false', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labels, `${prefix}-net`]);
  assert.deepEqual(calls[1], ['volume', 'create', ...labels, `${prefix}-server`]);
  const run = calls[2];
  assert.deepEqual(run.slice(0, 8), ['run', '-d', '--name', `${prefix}-server`, '--hostname', 'mc-dev', '--network', `${prefix}-net`]);
  const pairs = [labels.slice(0, 2), labels.slice(2), ['--label', 'mc-harness.fixtures=f00'], ['-v', `${prefix}-server:/server`], ['-v', '/fx:/fixtures:ro'], ['-e', 'RCON_PASSWORD'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--pids-limit', '4096'], ['-e', 'MC_JAR=purpur.jar'], ['--add-host', 'bstats.org:127.0.0.1']];
  for (const pair of pairs) assert.ok(run.join('\0').includes(pair.join('\0')), pair.join(' '));
  assert.ok(!run.some((a) => a === '-p' || a.startsWith('--publish') || a === '-P' || a === '--memory'));
  assert.ok(!run.some((a) => a.startsWith('RCON_PASSWORD=') || a.includes('pw')), 'RCON password in argv');
  assert.deepEqual(envs[2], { RCON_PASSWORD: 'pw' });
  assert.equal(run.filter((a) => a === '--add-host').length, EGRESS_SINKS.length);
  assert.equal(run[run.length - 1], 'mc-dev:abc');
  assert.equal(calls.length, 3);
  const mem = recorder();
  createPod(p, { tag: 'mc-dev:abc', jar: 'purpur.jar', fixtures: '/fx', fixturesHash: 'f00', rconPassword: 'pw', memory: '6g' }, mem.d);
  assert.ok(mem.calls[2].join('\0').includes(['--memory', '6g'].join('\0')));
});

test('createJoin: own labelled network, locked-down socat, 127.0.0.1 only, then joined to the pod network', () => {
  const p = podOf(tmp(), 'dev');
  const { d, calls } = recorder();
  createJoin(p, 25599, 'socat@sha256:x', d);
  const prefix = `mc-${p.project}-dev`;
  const labels = ['--label', `mc-harness.project=${p.project}`, '--label', 'mc-harness.pod=dev'];
  assert.deepEqual(calls[0], ['network', 'create', '--ipv6=false', ...labels, `${prefix}-joinnet`]);
  const create = calls[1].join(' ');
  for (const part of [`--network ${prefix}-joinnet`, '-p 127.0.0.1:25599:25565', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 65534:65534', '--read-only', `TCP:${prefix}-server:25565`]) {
    assert.ok(create.includes(part), part);
  }
  assert.deepEqual(calls.slice(2), [['network', 'connect', `${prefix}-net`, `${prefix}-join`], ['start', `${prefix}-join`]]);
});

test('removePod removes the pod by label, containers first; --all drops the pod filter', () => {
  const p = podOf(tmp(), 'dev');
  const { d, calls } = recorder({ 'ps -aq': 'c1\nc2\n', 'volume ls -q': 'v1\n', 'network ls -q': '' });
  assert.equal(removePod(p, false, d), 3);
  const filters = ['--filter', `label=mc-harness.project=${p.project}`, '--filter', 'label=mc-harness.pod=dev'];
  assert.deepEqual(calls, [['ps', '-aq', ...filters], ['rm', '-f', 'c1', 'c2'], ['volume', 'ls', '-q', ...filters], ['volume', 'rm', 'v1'], ['network', 'ls', '-q', ...filters]]);
  const all = recorder({ 'image ls -q': 'i1\ni1\ni2\n' });
  removePod(p, true, all.d);
  assert.deepEqual(all.calls[0], ['ps', '-aq', '--filter', `label=mc-harness.project=${p.project}`]);
  assert.deepEqual(all.calls.slice(-2), [['image', 'ls', '-q', '--filter', `label=mc-harness.project=${p.project}`], ['image', 'rm', '-f', 'i1', 'i2']]);
  assert.ok(!calls.some((c) => c[0] === 'image'), 'a plain down keeps the image');
});

test('pod names are validated', () => {
  assert.throws(() => podOf(tmp(), 'Bad Name'), /bad pod name/);
});

test('mergeFixtures: union of sources, identical overlap allowed, conflicting overlap refused', () => {
  const a = tmp();
  const b = tmp();
  write(a, { 'x.yml': '1', 'same.txt': 's' });
  write(b, { 'y/z.yml': '2', 'same.txt': 's' });
  const dest = join(tmp(), 'fixtures');
  const h = mergeFixtures([a, b], dest);
  assert.equal(readFileSync(join(dest, 'y/z.yml'), 'utf8'), '2');
  assert.equal(h, dirHash(dest));
  assert.equal(mergeFixtures([], join(tmp(), 'empty')), dirHash(join(tmp())));
  write(b, { 'x.yml': 'other' });
  assert.throws(() => mergeFixtures([a, b], dest), /fixture conflict: x\.yml/);
});

test('parseBootReport finds the boot time, enabled plugins, failures and errors', () => {
  const log = [
    '[00:00:01] [Server thread/INFO]: [LuckPerms] Enabling LuckPerms v5.4.1',
    '[00:00:02] [Server thread/INFO]: [Votifier] Enabling Votifier v2.7',
    '[00:00:02] [Server thread/ERROR]: Error occurred while enabling Votifier v2.7 (Is it up to date?)',
    "[00:00:01] [Server thread/ERROR]: Could not load 'plugins/Broken.jar' in folder 'plugins'",
    '[00:00:03] [Server thread/ERROR]: something else',
    '[00:00:03] [Server thread/INFO]: [CrazyEnvoys] Done (1.5s)!',
    '[00:00:04] [Server thread/INFO]: Done (12.345s)! For help, type "help"',
  ].join('\n');
  const r = parseBootReport(log);
  assert.equal(r.done, 12.345);
  assert.deepEqual(r.enabled, ['LuckPerms'], 'Votifier failed after its Enabling line');
  assert.deepEqual(r.failed.map((f) => f.plugin), ['Votifier', 'Broken']);
  assert.deepEqual(r.errors, ['[00:00:03] [Server thread/ERROR]: something else']);
  assert.equal(parseBootReport('').done, null);
});

test('formatBootReport against live: N/M, each plugin missing on dev with its error line', () => {
  const live = parseBootReport(['[a] [Server thread/INFO]: [A] Enabling A v1', '[a] [Server thread/INFO]: [B] Enabling B v1', '[a] [Server thread/INFO]: [C] Enabling C v1', '[a] [Server thread/INFO]: Done (30.5s)! For help, type "help"'].join('\n'));
  const dev = parseBootReport(['[a] [Server thread/INFO]: [A] Enabling A v1', '[a] [Server thread/INFO]: [B] Enabling B v1', '[a] [Server thread/ERROR]: Error occurred while enabling B v1 (Is it up to date?)', '[a] [Server thread/INFO]: [D] Enabling D v1', '[a] [Server thread/INFO]: Done (40s)! For help, type "help"'].join('\n'));
  const out = formatBootReport(dev, live);
  assert.match(out, /done: 40s \(live: 30\.5s\)/);
  assert.match(out, /plugins enabled: 1\/3 of live/);
  assert.match(out, /not enabled: B: \[a\] \[Server thread\/ERROR\]: Error occurred while enabling B/);
  assert.match(out, /not enabled: C: no error line names it/);
  assert.match(out, /enabled on dev only: D/);
});

test('bootTimeout is 3x the median recorded boot, at least 120s, 600s with none', () => {
  assert.equal(bootTimeout([]), 600);
  assert.equal(bootTimeout([10]), 120);
  assert.equal(bootTimeout([100, 50, 60]), 180);
});

// The CLI against a fake docker that knows no containers.
function cli(home: string, ...args: string[]) {
  const fake = join(tmp(), 'docker');
  writeFileSync(fake, '#!/bin/sh\nexit 1\n');
  chmodSync(fake, 0o755);
  return spawnSync(join(HARNESS_ROOT, 'bin/dev'), args, { env: { ...process.env, MC_HOME: home, MC_DOCKER: fake }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
}

test('bin/dev up refuses uncommitted server/ changes with exit 2', () => {
  const root = gitRepo({ 'server/a.jar': '1' });
  write(root, { 'server/new.yml': 'x' });
  const r = cli(root, 'up');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uncommitted changes[\s\S]*server\/new\.yml/);
});

test('bin/dev up refuses several root jars without --jar, and a --jar that is not one', () => {
  const root = gitRepo({ 'server/a.jar': '1', 'server/b.jar': '2' });
  let r = cli(root, 'up');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pick one with --jar NAME/);
  r = cli(root, 'up', '--jar', 'c.jar');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--jar c\.jar is not a jar/);
  r = cli(root, 'up', '--heap', 'lots');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad --heap/);
});

test('bin/dev refuses unknown commands, bad flags and absent pods with exit 2', () => {
  const root = gitRepo({ 'server/a.jar': '1' });
  for (const [args, msg] of [[['bogus'], /unknown command/], [['up', '--nope'], /unexpected argument/], [['restart'], /not up/], [['up', '--pod', 'X Y'], /bad pod name/], [[], /usage/]] as const) {
    const r = cli(root, ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, msg);
  }
});
