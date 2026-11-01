// Unit tests for bin/dev (src/dev/): overrides, image identity, build context,
// pod argv against a recording fake docker, fixtures, boot report, CLI refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DevError, type Docker } from '../../src/dev/docker.ts';
import { build, buildContext, dirHash, HARNESS_INPUTS, HARNESS_ROOT, identity, pruneImages, source, stepCached } from '../../src/dev/image.ts';
import { applyOverrides, setProperty } from '../../src/dev/overrides.ts';
import { createJoin, createPod, mergeFixtures, parseBootReport, podOf, removePod } from '../../src/dev/pod.ts';

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

test('overrides set online-mode=false in server.properties', () => {
  const cfg = tmp();
  write(cfg, { 'server.properties': 'online-mode=true\nmotd=hi\n' });
  const [a] = applyOverrides(cfg);
  assert.equal(a.content, 'online-mode=false\nmotd=hi\n');
  assert.match(a.note, /online-mode=false/);
});

test('an override is a no-op with a note when its file or key is absent', () => {
  const [absent] = applyOverrides(tmp());
  assert.equal(absent.content, null);
  assert.match(absent.note, /server.properties absent/);
  const cfg = tmp();
  write(cfg, { 'server.properties': 'motd=hi\n' });
  const [nokey] = applyOverrides(cfg);
  assert.equal(nokey.content, 'motd=hi\n');
  assert.match(nokey.note, /no online-mode key/);
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
  const { jar } = buildContext(source(root), ctx);
  assert.equal(jar, 'purpur.jar');
  for (const f of ['purpur.jar', 'libraries/x/y.jar', 'cache/mojang.jar', 'versions/26.1.2/v.jar', 'plugins/P.JAR']) assert.ok(existsSync(join(ctx, 'bin', f)), f);
  for (const f of ['plugins/P/config.yml', 'server.properties']) assert.ok(existsSync(join(ctx, 'cfg', f)), f);
  assert.equal(readFileSync(join(ctx, 'ovr/server.properties'), 'utf8'), 'online-mode=false\n');
  assert.equal(readFileSync(join(ctx, 'cfg/server.properties'), 'utf8'), 'online-mode=true\n');
  assert.ok(existsSync(join(ctx, 'Dockerfile')) && existsSync(join(ctx, 'entrypoint.sh')));
});

test('the build context needs exactly one root jar and refuses committed symlinks', () => {
  assert.throws(() => buildContext(source(gitRepo({ 'server/a.jar': '1', 'server/b.jar': '2' })), tmp()), /exactly one \*\.jar.*a\.jar, b\.jar/);
  assert.throws(() => buildContext(source(gitRepo({ 'server/plugins/x.yml': '1' })), tmp()), /found none/);
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
  createPod(p, { tag: 'mc-dev:abc', fixtures: '/fx', fixturesHash: 'f00', rconPassword: 'pw' }, d);
  const labels = ['--label', `mc-harness.project=${p.project}`, '--label', 'mc-harness.pod=dev'];
  const prefix = `mc-${p.project}-dev`;
  assert.deepEqual(calls[0], ['network', 'create', '--internal', '--ipv6=false', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labels, `${prefix}-net`]);
  assert.deepEqual(calls[1], ['volume', 'create', ...labels, `${prefix}-server`]);
  const run = calls[2];
  assert.deepEqual(run.slice(0, 8), ['run', '-d', '--name', `${prefix}-server`, '--hostname', 'mc-dev', '--network', `${prefix}-net`]);
  const pairs = [labels.slice(0, 2), labels.slice(2), ['--label', 'mc-harness.fixtures=f00'], ['-v', `${prefix}-server:/server`], ['-v', '/fx:/fixtures:ro'], ['-e', 'RCON_PASSWORD'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--pids-limit', '4096']];
  for (const pair of pairs) assert.ok(run.join('\0').includes(pair.join('\0')), pair.join(' '));
  assert.ok(!run.some((a) => a === '-p' || a.startsWith('--publish') || a === '-P' || a === '--memory'));
  assert.ok(!run.some((a) => a.startsWith('RCON_PASSWORD=') || a.includes('pw')), 'RCON password in argv');
  assert.deepEqual(envs[2], { RCON_PASSWORD: 'pw' });
  assert.equal(run[run.length - 1], 'mc-dev:abc');
  assert.equal(calls.length, 3);
  const mem = recorder();
  createPod(p, { tag: 'mc-dev:abc', fixtures: '/fx', fixturesHash: 'f00', rconPassword: 'pw', memory: '6g' }, mem.d);
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
    '[00:00:04] [Server thread/INFO]: Done (12.345s)! For help, type "help"',
  ].join('\n');
  const r = parseBootReport(log);
  assert.equal(r.done, 12.345);
  assert.deepEqual(r.enabled, ['LuckPerms', 'Votifier']);
  assert.deepEqual(r.failed.map((f) => f.plugin), ['Votifier', 'Broken']);
  assert.deepEqual(r.errors, ['[00:00:03] [Server thread/ERROR]: something else']);
  assert.equal(parseBootReport('').done, null);
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

test('bin/dev refuses unknown commands, bad flags and absent pods with exit 2', () => {
  const root = gitRepo({ 'server/a.jar': '1' });
  for (const [args, msg] of [[['bogus'], /unknown command/], [['up', '--nope'], /unexpected argument/], [['restart'], /not up/], [['up', '--pod', 'X Y'], /bad pod name/], [[], /usage/]] as const) {
    const r = cli(root, ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, msg);
  }
});
