// Unit tests for bin/dev (src/dev/): overrides, image identity, build context,
// pod argv against a recording fake docker, fixtures, boot report, CLI refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DevError, type Docker } from '../../src/dev/docker.ts';
import { buildContext, dirHash, HARNESS_INPUTS, HARNESS_ROOT, identity, source, stepCached } from '../../src/dev/image.ts';
import { applyOverrides, setProperty } from '../../src/dev/overrides.ts';
import { createPod, mergeFixtures, parseBootReport, podOf, removePod } from '../../src/dev/pod.ts';

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

// A docker stand-in that records argv and answers from a table of prefixes.
function recorder(answers: Record<string, string> = {}): { d: Docker; calls: string[][] } {
  const calls: string[][] = [];
  const d: Docker = (args) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(' ').startsWith(k));
    return { status: 0, stdout: key ? answers[key] : '', stderr: '' };
  };
  return { d, calls };
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

test('an untracked server/ is a plain directory: commit none, content-hashed, symlinks refused', () => {
  const root = tmp();
  write(root, { 'server/a.txt': 'a' });
  const src = source(root);
  assert.equal(src.kind, 'dir');
  const id = identity(src);
  assert.equal(id.commit, 'none');
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

test('createPod: internal network without a gateway, labelled volume, no published port', () => {
  const p = podOf(tmp(), 'dev');
  const { d, calls } = recorder();
  createPod(p, { tag: 'mc-dev:abc', fixtures: '/fx', fixturesHash: 'f00', rconPassword: 'pw' }, d);
  const labels = ['--label', `mc-harness.project=${p.project}`, '--label', 'mc-harness.pod=dev'];
  const prefix = `mc-${p.project}-dev`;
  assert.deepEqual(calls[0], ['network', 'create', '--internal', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labels, `${prefix}-net`]);
  assert.deepEqual(calls[1], ['volume', 'create', ...labels, `${prefix}-server`]);
  const run = calls[2];
  assert.deepEqual(run.slice(0, 8), ['run', '-d', '--name', `${prefix}-server`, '--hostname', 'mc-dev', '--network', `${prefix}-net`]);
  for (const pair of [labels.slice(0, 2), labels.slice(2), ['--label', 'mc-harness.fixtures=f00'], ['-v', `${prefix}-server:/server`], ['-v', '/fx:/fixtures:ro'], ['-e', 'RCON_PASSWORD=pw'], ['--cap-drop', 'ALL']]) {
    assert.ok(run.join('\0').includes(pair.join('\0')), pair.join(' '));
  }
  assert.ok(!run.some((a) => a === '-p' || a.startsWith('--publish') || a === '-P'));
  assert.equal(run[run.length - 1], 'mc-dev:abc');
  assert.equal(calls.length, 3);
});

test('removePod removes the pod by label, containers first; --all drops the pod filter', () => {
  const p = podOf(tmp(), 'dev');
  const { d, calls } = recorder({ 'ps -aq': 'c1\nc2\n', 'volume ls -q': 'v1\n', 'network ls -q': '' });
  assert.equal(removePod(p, false, d), 3);
  const filters = ['--filter', `label=mc-harness.project=${p.project}`, '--filter', 'label=mc-harness.pod=dev'];
  assert.deepEqual(calls, [['ps', '-aq', ...filters], ['rm', '-f', 'c1', 'c2'], ['volume', 'ls', '-q', ...filters], ['volume', 'rm', 'v1'], ['network', 'ls', '-q', ...filters]]);
  const all = recorder();
  removePod(p, true, all.d);
  assert.deepEqual(all.calls[0], ['ps', '-aq', '--filter', `label=mc-harness.project=${p.project}`]);
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
