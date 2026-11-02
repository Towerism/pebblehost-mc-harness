// Unit tests for the pod's egress proxy (src/relay/egress.ts): pod-egress
// parsing, host matching, and the proxy against an in-process upstream that
// stands in for every allowed host (the dial is injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { allowed, parseEgress, serveEgress } from '../../src/relay/egress.ts';

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

async function proxy(allow: string[], up: number, idleMs = 30_000) {
  const dials: string[] = [];
  const logs: string[] = [];
  const server = await serveEgress(allow, 0, (host, port) => (dials.push(`${host}:${port}`), connect(up, '127.0.0.1')), idleMs, (l) => logs.push(l));
  return { server, port: (server.address() as AddressInfo).port, dials, logs };
}

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
  const px = await proxy(['vcs.example.org'], up.port, 200);
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
