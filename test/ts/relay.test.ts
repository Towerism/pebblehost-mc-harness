// Unit tests for the relay (src/relay/): the RCON codec and client against an
// in-process fake RCON server, the daemon's framing and dispatch, the client's
// exit codes, and bin/dev console against a fake docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleOps, handle, rconSession, serve } from '../../src/relay/daemon.ts';
import { AUTH, Decoder, encode, EXEC, MARKER, MAX_BODY, Rcon } from '../../src/relay/rcon.ts';
import { HARNESS_ROOT } from '../../src/dev/image.ts';
import { clientTimeout } from '../../src/relay/client.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'relay-test-'));
const BIG = `${'a'.repeat(4095)}é${'b'.repeat(100)}`;

// A vanilla-like RCON server: password pw; `big` is answered in two packets
// that split a UTF-8 character, `hang` never; unknown types get "Unknown
// request". With slow, every reply goes out one byte at a time.
async function fakeRcon(opts: { slow?: boolean } = {}): Promise<{ port: number; server: Server; conns: Socket[]; commands: string[] }> {
  const conns: Socket[] = [];
  const commands: string[] = [];
  const server = createServer((s) => {
    conns.push(s);
    const dec = new Decoder();
    let authed = false;
    let hung = false;
    const send = (b: Buffer) => {
      if (!opts.slow) return void s.write(b);
      for (const byte of b) s.write(Buffer.from([byte]));
    };
    s.on('error', () => {});
    s.on('data', (chunk) => {
      for (const f of dec.push(chunk)) {
        // Vanilla handles a connection's packets in order: nothing after a hang.
        if (hung) return;
        const body = f.body.toString('utf8');
        if (f.type === AUTH) {
          authed = body === 'pw';
          send(encode(authed ? f.id : -1, EXEC, ''));
        } else if (f.type === EXEC && authed) {
          commands.push(body);
          if (body === 'hang') hung = true;
          if (hung) continue;
          if (body === 'big') {
            const b = Buffer.from(BIG);
            for (const part of [b.subarray(0, 4096), b.subarray(4096)]) {
              const p = Buffer.alloc(14 + part.length);
              p.writeInt32LE(10 + part.length, 0);
              p.writeInt32LE(f.id, 4);
              part.copy(p, 12);
              send(p);
            }
          } else send(encode(f.id, 0, `ran ${body}`));
        } else send(encode(f.id, 0, `Unknown request ${f.type.toString(16)}`));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, server, conns, commands };
}

test('encode writes length, id, type, body and two NULs; Decoder reassembles any split', () => {
  const p = encode(7, EXEC, 'list');
  assert.deepEqual([...p.subarray(0, 12)], [14, 0, 0, 0, 7, 0, 0, 0, 2, 0, 0, 0]);
  assert.equal(p.subarray(12, 16).toString(), 'list');
  assert.deepEqual([...p.subarray(16)], [0, 0]);
  const stream = Buffer.concat([p, encode(-1, 0, 'é'), encode(9, MARKER, '')]);
  for (const cut of [1, 3, 13, 17, 20, stream.length - 1]) {
    const dec = new Decoder();
    const frames = [...dec.push(stream.subarray(0, cut)), ...dec.push(stream.subarray(cut))];
    assert.deepEqual(frames.map((f) => [f.id, f.type, f.body.toString()]), [[7, 2, 'list'], [-1, 0, 'é'], [9, MARKER, '']], `cut at ${cut}`);
  }
  const bad = Buffer.alloc(4);
  bad.writeInt32LE(3, 0);
  assert.throws(() => new Decoder().push(bad), /bad packet length 3/);
});

test('Rcon authenticates, runs commands in order and joins a reply split over packets', async () => {
  const f = await fakeRcon({ slow: true });
  const r = await Rcon.connect('127.0.0.1', f.port, 'pw');
  const [a, big, b] = await Promise.all([r.command('list'), r.command('big'), r.command('say hi')]);
  assert.equal(a, 'ran list');
  assert.equal(big, BIG);
  assert.equal(b, 'ran say hi');
  assert.deepEqual(f.commands, ['list', 'big', 'say hi']);
  await assert.rejects(r.command('x'.repeat(MAX_BODY + 1)), /over 1446 bytes/);
  r.close();
  f.server.close();
});

test('Rcon rejects a wrong password, and times out and closes on a missing reply', async () => {
  const f = await fakeRcon();
  await assert.rejects(Rcon.connect('127.0.0.1', f.port, 'nope'), /authentication failed/);
  const r = await Rcon.connect('127.0.0.1', f.port, 'pw', 200);
  await assert.rejects(r.command('hang'), /no reply within 200ms/);
  assert.equal(r.closed, true);
  await assert.rejects(r.command('list'), /connection closed/);
  f.server.close();
});

test('rconSession keeps one connection, and reconnects after the server drops it', async () => {
  const f = await fakeRcon();
  const s = rconSession({ host: '127.0.0.1', port: f.port, password: 'pw' });
  assert.equal(await s.command('a'), 'ran a');
  assert.equal(await s.command('b'), 'ran b');
  assert.equal(f.conns.length, 1);
  for (const c of f.conns) c.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await s.command('c'), 'ran c');
  assert.equal(f.conns.length, 2);
  await s.close();
  await new Promise<void>((r) => f.server.close(() => r()));
  await assert.rejects(s.command('d'), /ECONNREFUSED/);
});

test('handle dispatches by op and turns every failure into an error reply', async () => {
  const ops = { echo: async (req: { op: string } & Record<string, unknown>) => ({ got: req.v }), boom: async () => { throw new Error('bad'); } };
  assert.deepEqual(await handle('{"op":"echo","v":1}', ops), { ok: true, got: 1 });
  assert.deepEqual(await handle('nope', ops), { ok: false, error: 'request is not JSON' });
  assert.deepEqual(await handle('{"v":1}', ops), { ok: false, error: 'request needs an op' });
  assert.deepEqual(await handle('{"op":"toString"}', ops), { ok: false, error: 'unknown op toString' });
  assert.deepEqual(await handle('{"op":"boom"}', ops), { ok: false, error: 'bad' });
  const con = consoleOps({ command: async (c) => `ran ${c}`, close: async () => {} });
  assert.deepEqual(await handle('{"op":"console","command":"list"}', con), { ok: true, reply: 'ran list' });
  assert.deepEqual(await handle('{"op":"console","command":" "}', con), { ok: false, error: 'console needs a command' });
});

function ask(path: string, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const c = createConnection(path, () => c.write(data));
    c.setEncoding('utf8');
    c.on('data', (s) => (out += s));
    c.on('end', () => resolve(out));
    c.on('error', reject);
  });
}

test('serve answers one JSON line per connection: a newline or EOF ends the request; owner-only socket', async () => {
  const path = join(tmp(), 'relay.sock');
  const server = await serve(path, { echo: async (req) => ({ got: req.v }) });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(await ask(path, '{"op":"echo","v":"a"}\n{"op":"echo","v":"ignored"}\n'), '{"ok":true,"got":"a"}\n');
  const half = await new Promise<string>((resolve) => {
    let out = '';
    const c = createConnection(path, () => c.end('{"op":"echo","v":"b"}'));
    c.setEncoding('utf8');
    c.on('data', (s) => (out += s));
    c.on('end', () => resolve(out));
  });
  assert.equal(half, '{"ok":true,"got":"b"}\n');
  assert.match(await ask(path, 'x'.repeat(70 * 1024)), /request over 65536 bytes/);
  await new Promise((r) => server.close(r));
});

test('serve drops a client that never finishes its request, with an error reply, and keeps serving', async () => {
  const path = join(tmp(), 'relay.sock');
  const server = await serve(path, { echo: async (req) => ({ got: req.v }) }, 100);
  const t0 = Date.now();
  const stalled = await new Promise<string>((resolve) => {
    let out = '';
    const c = createConnection(path, () => c.write('{"op":"echo"'));
    c.setEncoding('utf8');
    c.on('data', (s) => (out += s));
    c.on('close', () => resolve(out));
  });
  assert.equal(stalled, '{"ok":false,"error":"no complete request within 100ms"}\n');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await ask(path, '{"op":"echo","v":2}\n'), '{"ok":true,"got":2}\n');
  await new Promise((r) => server.close(r));
});

function run(cmd: string, args: string[], env: Record<string, string>, input: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (s) => (stdout += s));
    c.stderr.on('data', (s) => (stderr += s));
    c.on('close', (status) => resolve({ status: status ?? 2, stdout, stderr }));
    c.stdin.end(input);
  });
}

const CLIENT = join(HARNESS_ROOT, 'src/relay/client.ts');
const DAEMON = join(HARNESS_ROOT, 'src/relay/daemon.ts');

test('client prints the one reply line; exit 0 when ok, 2 on an error reply, a dead socket or bad input', async () => {
  const path = join(tmp(), 'relay.sock');
  const server = await serve(path, { echo: async (req) => ({ got: req.v }) });
  let r = await run('node', [CLIENT], { RELAY_SOCKET: path }, '{"op":"echo","v":1}\n');
  assert.deepEqual([r.status, r.stdout], [0, '{"ok":true,"got":1}\n']);
  r = await run('node', [CLIENT], { RELAY_SOCKET: path }, '{"op":"nope"}');
  assert.deepEqual([r.status, r.stdout], [2, '{"ok":false,"error":"unknown op nope"}\n']);
  r = await run('node', [CLIENT], { RELAY_SOCKET: path }, '');
  assert.deepEqual([r.status, JSON.parse(r.stdout).error], [2, 'send one JSON request on stdin']);
  await new Promise((res) => server.close(res));
  r = await run('node', [CLIENT], { RELAY_SOCKET: path }, '{"op":"echo"}');
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).error, /relay not reachable: .*ENOENT/);
});

test('the daemon process keeps its RCON connection across client calls and exits 0 on SIGTERM', async () => {
  const f = await fakeRcon();
  const path = join(tmp(), 'relay.sock');
  const daemon = spawn('node', [DAEMON], { env: { ...process.env, RELAY_SOCKET: path, RCON_HOST: '127.0.0.1', RCON_PORT: String(f.port), RCON_PASSWORD: 'pw' }, stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
  for (const cmd of ['list', 'version']) {
    const r = await run('node', [CLIENT], { RELAY_SOCKET: path }, JSON.stringify({ op: 'console', command: cmd }));
    assert.deepEqual([r.status, JSON.parse(r.stdout)], [0, { ok: true, reply: `ran ${cmd}` }]);
  }
  assert.equal(f.conns.length, 1);
  const code = await new Promise((r) => {
    daemon.on('exit', r);
    daemon.kill('SIGTERM');
  });
  assert.equal(code, 0);
  f.server.close();
});

test('the client waits a minute past the request timeoutMs, so a long bot wait is never cut short', () => {
  assert.equal(clientTimeout('{"op":"console","command":"list"}'), 60_000);
  assert.equal(clientTimeout('{"op":"bot.waitMessage","name":"Steve","regex":"x","timeoutMs":90000}'), 150_000);
  assert.equal(clientTimeout('{"op":"bot.join","name":"Steve","timeoutMs":9999999}'), 660_000);
  assert.equal(clientTimeout('not json'), 60_000);
  assert.equal(clientTimeout('{"op":"x","timeoutMs":-5}'), 60_000);
});

test('the daemon refuses to start without RCON_HOST or RCON_PASSWORD', () => {
  const r = spawnSync('node', [DAEMON], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /RCON_HOST is not set/);
});

// bin/dev with a fake docker: inspect answers from FAKE_SERVER/FAKE_RELAY
// (empty: no such container), exec prints FAKE_REPLY. argv and stdin are logged.
function consoleCli(env: Record<string, string>, ...args: string[]) {
  const dir = tmp();
  const fake = join(dir, 'docker');
  writeFileSync(fake, `#!/bin/sh
echo "$*" >>"${dir}/argv"
case "$1" in
  inspect) case "$4" in *-server) st=$FAKE_SERVER ;; *) st=$FAKE_RELAY ;; esac; [ -n "$st" ] || exit 1
    case "$3" in *Labels*) echo '{"mc-harness.generation":"g1"}' ;; *) echo "$st" ;; esac ;;
  exec) [ "$2" = -i ] || exit 0; cat >"${dir}/stdin"; printf '%s' "$FAKE_REPLY" ;;
esac
`);
  chmodSync(fake, 0o755);
  const r = spawnSync(join(HARNESS_ROOT, 'bin/dev'), args, { env: { ...process.env, MC_HOME: dir, MC_DOCKER: fake, FAKE_SERVER: 'running', FAKE_RELAY: 'running', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  return { ...r, argv: read('argv'), stdin: read('stdin') };
}

test('bin/dev console sends the words as one console request through docker exec -i, prints the exact reply and marks the volume explored', () => {
  const r = consoleCli({ FAKE_REPLY: '{"ok":true,"reply":"There are 0 of a max of 20 players online: "}\n' }, 'console', '--pod', 'p2', 'say', '--pod', 'hi');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'There are 0 of a max of 20 players online: \n');
  assert.deepEqual(JSON.parse(r.stdin), { op: 'console', command: 'say --pod hi' });
  const exec = r.argv.split('\n').find((l) => l.startsWith('exec -i '));
  assert.match(exec ?? '', /^exec -i mc-[0-9a-f]{8}-p2-relay node \/relay\/client\.ts$/);
  // A human touched the volume: its runs no longer count for the gate.
  assert.match(r.argv, /^exec mc-[0-9a-f]{8}-p2-server touch \/server\/\.mc-harness-explored$/m);
  const dashed = consoleCli({ FAKE_REPLY: '{"ok":true,"reply":""}' }, 'console', '--', '--weird');
  assert.deepEqual([dashed.status, dashed.stdout, JSON.parse(dashed.stdin).command], [0, '', '--weird']);
});

test('bin/dev bot sends one bot request per call through the relay and marks the volume explored', () => {
  let r = consoleCli({ FAKE_REPLY: '{"ok":true,"name":"Steve"}' }, 'bot', '--pod', 'p2', 'join', 'Steve');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'bot: Steve joined\n');
  assert.deepEqual(JSON.parse(r.stdin), { op: 'bot.join', name: 'Steve' });
  assert.match(r.argv, /^exec mc-[0-9a-f]{8}-p2-server touch \/server\/\.mc-harness-explored$/m);
  r = consoleCli({ FAKE_REPLY: '{"ok":true}' }, 'bot', '--pod', 'p2', 'chat', 'Steve', '/me', 'waves');
  assert.deepEqual([r.status, r.stdout, JSON.parse(r.stdin)], [0, 'bot: Steve sent\n', { op: 'bot.chat', name: 'Steve', message: '/me waves' }]);
  r = consoleCli({ FAKE_REPLY: '{"ok":true,"line":"[Server] hi"}' }, 'bot', '--timeout', '3', 'wait', 'Steve', 'hi$');
  assert.deepEqual([r.status, r.stdout, JSON.parse(r.stdin)], [0, '[Server] hi\n', { op: 'bot.waitMessage', name: 'Steve', regex: 'hi$', timeoutMs: 3000 }]);
  // --timeout after the bot's words is an option, not part of the regex.
  r = consoleCli({ FAKE_REPLY: '{"ok":true,"line":"done"}' }, 'bot', 'wait', 'Steve', 'all done', '--timeout', '45');
  assert.deepEqual([r.status, JSON.parse(r.stdin)], [0, { op: 'bot.waitMessage', name: 'Steve', regex: 'all done', timeoutMs: 45000 }]);
  r = consoleCli({}, 'bot', 'wait', 'Steve', 'x', '--timeout', 'soon');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad --timeout/);
  r = consoleCli({ FAKE_REPLY: '{"ok":true,"bots":["Alex","Steve"]}' }, 'bot', '--pod', 'p2', 'list');
  assert.deepEqual([r.status, r.stdout], [0, 'Alex\nSteve\n']);
  assert.doesNotMatch(r.argv, /touch/, 'list does not mark the volume explored');
  for (const [args, msg] of [[['bot'], /bot needs join NAME/], [['bot', 'dance', 'Steve'], /bot needs join NAME/], [['bot', 'chat', 'Steve'], /bot chat needs the text/]] as const) {
    r = consoleCli({}, ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, msg);
  }
  r = consoleCli({ FAKE_REPLY: '{"ok":false,"error":"no bot Steve; bot.join it first"}' }, 'bot', 'quit', 'Steve');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no bot Steve; bot\.join it first/);
});

test('bin/dev console exits 2 with a reason when the pod, server or relay is not up, or the relay reports an error', () => {
  const cases: [Record<string, string>, string[], RegExp][] = [
    [{}, ['console'], /console needs a server command/],
    [{ FAKE_SERVER: '' }, ['console', 'list'], /pod dev is not up/],
    [{ FAKE_SERVER: 'exited' }, ['console', 'list'], /server of pod dev is exited/],
    [{ FAKE_RELAY: '' }, ['console', 'list'], /relay of pod dev is missing; bin\/dev rebuild recreates it/],
    [{ FAKE_REPLY: '{"ok":false,"error":"rcon: connect ECONNREFUSED 172.18.0.2:25575"}' }, ['console', 'list'], /rcon: connect ECONNREFUSED/],
    [{ FAKE_REPLY: 'OCI runtime exec failed' }, ['console', 'list'], /relay gave no reply/],
  ];
  for (const [env, args, msg] of cases) {
    const r = consoleCli(env, ...args);
    assert.equal(r.status, 2, `${JSON.stringify(env)} ${r.stdout}`);
    assert.match(r.stderr, msg);
  }
});
