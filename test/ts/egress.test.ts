// Unit tests for the pod's egress proxy (src/relay/egress.ts): pod-egress
// parsing, host matching, and the proxy against an in-process upstream that
// stands in for every allowed host (the dial is injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer, Socket, type AddressInfo, type Server } from 'node:net';
import { allowed, parseEgress, serveEgress, type EgressOpts } from '../../src/relay/egress.ts';

test('parseEgress: hosts and .suffixes, comments and blanks skipped, case folded, sorted and unique', () => {
  assert.deepEqual(parseEgress(''), []);
  assert.deepEqual(parseEgress('# only a comment\n\n   \n'), []);
  assert.deepEqual(parseEgress('vcs.example.org\n.DropboxUserContent.com # packs\r\nvcs.example.org\nwww.dropbox.com\n'), ['.dropboxusercontent.com', 'vcs.example.org', 'www.dropbox.com']);
});

test('parseEgress refuses anything but a host name or .suffix, naming the line', () => {
  for (const bad of ['https://a.example.org', 'a.example.org:443', 'a.example.org/x', '*.example.org', 'a b.example.org', 'localhost', '.com', 'com', '1.2.3.4', '[::1]', 'a.example.org.', '-a.example.org', 'a..example.org', 'ä.example.org', '.', `${'a'.repeat(64)}.example.org`]) {
    assert.throws(() => parseEgress(`ok.example.org\n${bad}\n`), (e) => e instanceof Error && e.message.startsWith('line 2: '), bad);
  }
});

test('allowed: exact host, or a subdomain of a .suffix entry only', () => {
  const list = parseEgress('vcs.example.org\n.dropboxusercontent.com\n');
  assert.ok(allowed(list, 'vcs.example.org'));
  assert.ok(allowed(list, 'VCS.Example.org'));
  assert.ok(allowed(list, 'dl.dropboxusercontent.com'));
  assert.ok(allowed(list, 'a.b.dropboxusercontent.com'));
  for (const no of ['dropboxusercontent.com', 'evildropboxusercontent.com', 'x.vcs.example.org', 'vcs.example.org.evil.com', 'vcs.example.org.', '127.0.0.1', '']) assert.ok(!allowed(list, no), no);
  assert.ok(!allowed([], 'vcs.example.org'));
});

// An upstream that answers each line with "echo <line>"; dials record their
// target.
async function upstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((s) => {
    s.setEncoding('utf8');
    s.on('data', (d: string) => s.write(`echo ${d}`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

async function proxy(allow: string[], up: number, o: Omit<EgressOpts, 'dial' | 'log'> & { dial?: () => Socket } = {}) {
  const dials: string[] = [];
  const logs: string[] = [];
  const server = await serveEgress(allow, 0, { ...o, dial: (host, port) => (dials.push(`${host}:${port}`), o.dial ? o.dial() : connect(up, '127.0.0.1')), log: (l) => logs.push(l) });
  return { server, port: (server.address() as AddressInfo).port, dials, logs };
}

// Open a tunnel to `vcs.example.org` through the proxy; resolves once the
// 200 is in.
function tunnel(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const c = connect(port, '127.0.0.1');
    c.once('data', (b) => (String(b).startsWith('HTTP/1.1 200') ? resolve(c) : reject(new Error(String(b)))));
    c.on('error', reject);
    c.write('CONNECT vcs.example.org:443 HTTP/1.1\r\n\r\n');
  });
}

const closed = (s: Socket) => new Promise<void>((r) => (s.destroyed ? r() : s.once('close', () => r())));

// Send `request`, then read until the proxy closes or `until` matches.
function exchange(port: number, request: string, until?: RegExp, then?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(port, '127.0.0.1');
    let got = '';
    let sent = false;
    c.setEncoding('utf8');
    c.on('data', (d: string) => {
      got += d;
      if (until && until.test(got)) {
        if (then !== undefined && !sent) {
          sent = true;
          c.write(then);
          return;
        }
        c.end();
      }
    });
    c.on('close', () => resolve(got));
    c.on('error', reject);
    c.write(request);
  });
}

test('serveEgress tunnels CONNECT to port 443 of an allowed host, bytes both ways', async () => {
  const up = await upstream();
  const px = await proxy(['.dropboxusercontent.com'], up.port);
  try {
    const got = await exchange(px.port, 'CONNECT dl.dropboxusercontent.com:443 HTTP/1.1\r\nHost: dl.dropboxusercontent.com:443\r\n\r\n', /\r\n\r\n(echo hello\n)?$/, 'hello\n');
    assert.equal(got, 'HTTP/1.1 200 Connection established\r\n\r\necho hello\n');
    assert.deepEqual(px.dials, ['dl.dropboxusercontent.com:443']);
    assert.deepEqual(px.logs, ['allow dl.dropboxusercontent.com:443']);
  } finally {
    px.server.close();
    up.server.close();
  }
});

test('serveEgress answers 403 to an unlisted host, another port, plain HTTP and junk, and dials nothing', async () => {
  const up = await upstream();
  const px = await proxy(['vcs.example.org'], up.port);
  try {
    for (const req of ['CONNECT evil.example.org:443 HTTP/1.1\r\n\r\n', 'CONNECT vcs.example.org:22 HTTP/1.1\r\n\r\n', 'CONNECT vcs.example.org:4430 HTTP/1.1\r\n\r\n', 'CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n', 'GET http://vcs.example.org/ HTTP/1.1\r\nHost: vcs.example.org\r\n\r\n', 'CONNECT vcs.example.org:443 HTTP/1.1 extra\r\n\r\n', 'hello\r\n\r\n']) {
      const got = await exchange(px.port, req);
      assert.match(got, /^HTTP\/1\.1 403 Forbidden\r\n/, req);
    }
    assert.deepEqual(px.dials, []);
    assert.equal(px.logs.length, 7);
    assert.ok(px.logs.every((l) => l.startsWith('deny ')));
  } finally {
    px.server.close();
    up.server.close();
  }
});

test('serveEgress refuses an oversized head and drops a client that never finishes one', async () => {
  const up = await upstream();
  const px = await proxy(['vcs.example.org'], up.port, { headMs: 200 });
  try {
    assert.match(await exchange(px.port, `CONNECT vcs.example.org:443 HTTP/1.1\r\nX: ${'a'.repeat(9000)}`), /^HTTP\/1\.1 431 /);
    assert.equal(await exchange(px.port, 'CONNECT vcs.example.org:443 HTTP/1.1\r\n'), '');
    assert.deepEqual(px.dials, []);
  } finally {
    px.server.close();
    up.server.close();
  }
});

test('serveEgress answers 502 when the allowed host cannot be reached', async () => {
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  const port = (dead.address() as AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));
  const px = await proxy(['vcs.example.org'], port);
  try {
    assert.match(await exchange(px.port, 'CONNECT vcs.example.org:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502 Bad Gateway\r\n/);
  } finally {
    px.server.close();
  }
});

test('serveEgress answers 502 when the upstream connect does not finish within connectMs', async () => {
  // A socket that never connects stands in for a SYN nobody answers.
  const px = await proxy(['vcs.example.org'], 0, { connectMs: 150, dial: () => new Socket() });
  try {
    const t0 = Date.now();
    assert.match(await exchange(px.port, 'CONNECT vcs.example.org:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502 Bad Gateway\r\n/);
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(px.logs, ['deny vcs.example.org:443: no connect within 150ms']);
  } finally {
    px.server.close();
  }
});

test('serveEgress closes both sides of a tunnel with no byte either way for idleMs', async () => {
  // The upstream takes the client's bytes and never answers: a dead flow.
  const ups: Socket[] = [];
  const up = createServer((s) => (ups.push(s), s.resume()));
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const px = await proxy(['vcs.example.org'], (up.address() as AddressInfo).port, { idleMs: 200 });
  try {
    const c = await tunnel(px.port);
    c.write('client hello');
    const t0 = Date.now();
    await closed(c);
    assert.ok(Date.now() - t0 < 2000);
    await closed(ups[0]);
    assert.deepEqual(px.logs, ['allow vcs.example.org:443', 'close vcs.example.org:443: idle 200ms']);
  } finally {
    px.server.close();
    up.close();
  }
});

test('serveEgress keeps a tunnel that moves bytes one way open past idleMs', async () => {
  // A slow download: one byte every 50ms for 500ms, then the upstream ends.
  const up = createServer((s) => {
    let n = 0;
    const t = setInterval(() => (++n === 10 ? (clearInterval(t), s.end('.')) : s.write('.')), 50);
    s.on('close', () => clearInterval(t));
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const px = await proxy(['vcs.example.org'], (up.address() as AddressInfo).port, { idleMs: 200 });
  try {
    const c = await tunnel(px.port);
    let got = '';
    c.on('data', (b) => (got += b));
    await closed(c);
    assert.equal(got, '.'.repeat(10));
    assert.ok(!px.logs.some((l) => l.startsWith('close ')));
  } finally {
    px.server.close();
    up.close();
  }
});

test('serveEgress closes the client when the upstream goes, and the upstream when the client goes', async () => {
  const ups: Socket[] = [];
  const up = createServer((s) => ups.push(s));
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const px = await proxy(['vcs.example.org'], (up.address() as AddressInfo).port);
  try {
    const a = await tunnel(px.port);
    ups[0].destroy();
    await closed(a);
    const b = await tunnel(px.port);
    b.destroy();
    await closed(ups[1]);
  } finally {
    px.server.close();
    up.close();
  }
});
