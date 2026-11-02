// Egress proxy: a pod's only way out, run from the relay image when the
// project's pod-egress lists hosts. It sits on the pod's internal network and
// on a network of its own with a gateway. It answers HTTP CONNECT to port 443
// of a listed host with a tunnel and everything else with 403: no plain HTTP
// (it would mean parsing and forwarding requests; TLS through CONNECT is
// enough for plugin downloads), no other port. Env: EGRESS_ALLOW (the parsed
// list, comma-separated), EGRESS_PORT (3128). Each decision is logged.
import { connect, createServer, type Server, type Socket } from 'node:net';

export const PORT = 3128;
const MAX_HEAD = 8 * 1024;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
// Two labels at least, the last with a letter: no bare TLD, no IP literal.
const HOST = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+(?=[a-z0-9-]*[a-z])${LABEL}$`);

// pod-egress: one host per line, # comments, a leading . for every subdomain
// of the rest (.example.com matches a.example.com, not example.com). Case is
// folded. Throws on the first bad line; returns the entries sorted, unique.
export function parseEgress(text: string): string[] {
  const out = new Set<string>();
  text.split('\n').forEach((raw, i) => {
    const entry = raw.replace(/#.*/, '').trim().toLowerCase();
    if (entry === '') return;
    if (!HOST.test(entry.startsWith('.') ? entry.slice(1) : entry)) throw new Error(`line ${i + 1}: ${JSON.stringify(raw.trim())} is not a host name or .suffix (a-z, 0-9, - and dots, two labels at least)`);
    out.add(entry);
  });
  return [...out].sort();
}

export function allowed(allow: string[], host: string): boolean {
  const h = host.toLowerCase();
  return HOST.test(h) && allow.some((e) => (e.startsWith('.') ? h.endsWith(e) : h === e));
}

export type Dial = (host: string, port: number) => Socket;
export type EgressOpts = { dial?: Dial; headMs?: number; connectMs?: number; idleMs?: number; log?: (line: string) => void };

// The request head must arrive within headMs and the upstream connect within
// connectMs (else 502). An open tunnel with no byte either way for idleMs is
// closed on both sides: an upstream flow that went dead (no ACK, no RST)
// would otherwise hold a client with no read timeout, and the pod's boot with
// it, until the kernel gives up some 15 minutes later. Either side closing or
// failing closes the other.
export function serveEgress(allow: string[], port = PORT, o: EgressOpts = {}): Promise<Server> {
  const { dial = (host, p) => connect(p, host), headMs = 30_000, connectMs = 10_000, idleMs = 60_000, log = (line) => process.stdout.write(`${line}\n`) } = o;
  const server = createServer((c) => {
    let head = Buffer.alloc(0);
    const deny = (status: string, why: string) => {
      log(`deny ${why}`);
      c.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    c.setTimeout(headMs, () => c.destroy());
    c.on('error', () => c.destroy());
    const onData = (b: Buffer) => {
      head = Buffer.concat([head, b]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_HEAD) {
          c.off('data', onData);
          deny('431 Request Header Fields Too Large', `request head over ${MAX_HEAD} bytes`);
        }
        return;
      }
      c.off('data', onData);
      c.pause();
      const first = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
      const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(first);
      if (!m) return deny('403 Forbidden', `not a CONNECT: ${JSON.stringify(first.slice(0, 200))}`);
      const [, host, p] = m;
      if (p !== '443') return deny('403 Forbidden', `${host}:${p}: only port 443`);
      if (!allowed(allow, host)) return deny('403 Forbidden', `${host}:443: not in pod-egress`);
      const up = dial(host, 443);
      let open = false;
      // Socket timeouts count reads and writes alike: a tunnel moving data
      // one way keeps both sides alive.
      const idle = () => {
        log(`close ${host}:443: idle ${idleMs}ms`);
        up.destroy();
        c.destroy();
      };
      up.setTimeout(connectMs, () => {
        if (open) return idle();
        up.destroy();
        deny('502 Bad Gateway', `${host}:443: no connect within ${connectMs}ms`);
      });
      up.once('connect', () => {
        open = true;
        log(`allow ${host}:443`);
        up.setTimeout(idleMs);
        c.removeAllListeners('timeout');
        c.setTimeout(idleMs, idle);
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length > 0) up.write(rest);
        c.pipe(up);
        up.pipe(c);
        c.resume();
      });
      up.on('error', (e) => (open ? c.destroy() : deny('502 Bad Gateway', `${host}:443: ${e.message}`)));
      up.on('close', () => open && c.destroy());
      // A client gone before the connect leaves no dial behind.
      c.on('close', () => up.destroy());
    };
    c.on('data', onData);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

if (import.meta.main) {
  let allow: string[] = [];
  try {
    allow = parseEgress((process.env.EGRESS_ALLOW ?? '').split(',').join('\n'));
  } catch (e) {
    process.stderr.write(`egress: EGRESS_ALLOW ${(e as Error).message}\n`);
    process.exit(2);
  }
  if (allow.length === 0) {
    process.stderr.write('egress: EGRESS_ALLOW is empty\n');
    process.exit(2);
  }
  const server = await serveEgress(allow, Number(process.env.EGRESS_PORT || PORT));
  process.stdout.write(`egress: allowing ${allow.join(', ')}\n`);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
}
