// Relay daemon: PID 1 of a pod's relay container, behind tini. Each connection
// to its unix socket carries one JSON request line and gets one JSON reply
// line. Requests are dispatched by `op` to a table of handlers: console (the
// pod's RCON connection, opened on first use and again after the server
// restarts) and bot.* (mineflayer sessions by name, bots.ts). Env: RCON_HOST,
// RCON_PASSWORD, RCON_PORT (25575), GAME_PORT (25565), RELAY_SOCKET.
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { botOps } from './bots.ts';
import { Rcon } from './rcon.ts';

export const SOCKET = '/run/relay.sock';
const MAX_REQUEST = 64 * 1024;

export type Request = { op: string } & Record<string, unknown>;
export type Reply = ({ ok: true } & Record<string, unknown>) | { ok: false; error: string };
export type Handler = (req: Request) => Promise<Record<string, unknown>>;
export type RconTarget = { host: string; port: number; password: string; timeoutMs?: number };
export type RconSession = { command: (cmd: string) => Promise<string>; close: () => Promise<void> };

// The pod's RCON connection. A dropped one (server restart) is replaced on
// the next command; a command never runs twice.
export function rconSession(t: RconTarget): RconSession {
  let open: Promise<Rcon> | null = null;
  const get = async () => {
    const cur = open && (await open.catch(() => null));
    if (cur && !cur.closed) return cur;
    open = Rcon.connect(t.host, t.port, t.password, t.timeoutMs);
    return open.catch((e) => {
      open = null;
      throw e;
    });
  };
  return {
    command: async (cmd) => (await get()).command(cmd),
    close: async () => (await open?.catch(() => null))?.close(),
  };
}

export function consoleOps(rcon: RconSession): Record<string, Handler> {
  return {
    console: async (req) => {
      if (typeof req.command !== 'string' || req.command.trim() === '') throw new Error('console needs a command');
      return { reply: await rcon.command(req.command) };
    },
  };
}

export async function handle(line: string, ops: Record<string, Handler>): Promise<Reply> {
  let req: unknown;
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, error: 'request is not JSON' };
  }
  if (typeof req !== 'object' || req === null || typeof (req as Request).op !== 'string') return { ok: false, error: 'request needs an op' };
  const { op } = req as Request;
  if (!Object.hasOwn(ops, op)) return { ok: false, error: `unknown op ${op}` };
  try {
    return { ok: true, ...(await ops[op](req as Request)) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// The request is the first line, or everything sent before the client's EOF.
// A client that sends neither within idleMs gets an error reply and is
// dropped; the handler itself has no such limit.
export function serve(path: string, ops: Record<string, Handler>, idleMs = 30_000): Promise<Server> {
  rmSync(path, { force: true });
  // allowHalfOpen: a client that ends its side right after the request still
  // gets the reply.
  const server = createServer({ allowHalfOpen: true }, (c) => {
    let buf = '';
    let answered = false;
    const answer = async (line: string) => {
      answered = true;
      c.setTimeout(0);
      c.end(`${JSON.stringify(await handle(line, ops))}\n`);
    };
    c.setTimeout(idleMs, () => {
      if (answered) return;
      answered = true;
      c.end(`${JSON.stringify({ ok: false, error: `no complete request within ${idleMs}ms` })}\n`);
      c.destroySoon();
    });
    c.setEncoding('utf8');
    c.on('data', (s: string) => {
      if (answered) return;
      buf += s;
      const nl = buf.indexOf('\n');
      if (nl >= 0) void answer(buf.slice(0, nl));
      else if (buf.length > MAX_REQUEST) {
        answered = true;
        c.end(`${JSON.stringify({ ok: false, error: `request over ${MAX_REQUEST} bytes` })}\n`);
      }
    });
    c.on('end', () => {
      if (!answered) void answer(buf);
    });
    c.on('error', () => c.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve(server);
    });
  });
}

if (import.meta.main) {
  const need = (k: string) => process.env[k] || (process.stderr.write(`relay: ${k} is not set\n`), process.exit(2));
  const rcon = rconSession({ host: need('RCON_HOST'), port: Number(process.env.RCON_PORT || 25575), password: need('RCON_PASSWORD') });
  // mineflayer is installed only in the relay image; without it (the unit
  // tests run this file on the host) the daemon serves console alone.
  const bots = await import('mineflayer').then(
    ({ createBot }) => botOps(createBot, { host: need('RCON_HOST'), port: Number(process.env.GAME_PORT || 25565), version: '26.1' }),
    () => ({}),
  );
  const server = await serve(process.env.RELAY_SOCKET || SOCKET, { ...consoleOps(rcon), ...bots });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      server.close();
      void rcon.close().finally(() => process.exit(0));
    });
  }
}
