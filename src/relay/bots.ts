// Headless bot sessions in the relay daemon, keyed by name, so a bot joined by
// one CLI call is still there for the next. Each session keeps the chat lines
// it received; waitMessage reads them from a cursor, so a reply that arrived
// between two calls is not lost. The mineflayer factory is injected: the
// daemon passes the real one, the unit tests a fake.
import type { Handler, Request } from './daemon.ts';

export type BotLike = {
  on(event: 'messagestr', fn: (text: string) => void): unknown;
  once(event: 'spawn', fn: () => void): unknown;
  once(event: 'end' | 'kicked' | 'error', fn: (reason: unknown) => void): unknown;
  chat(text: string): void;
  quit(): void;
};
export type CreateBot = (opts: { host: string; port: number; username: string; version: string; auth: 'offline' }) => BotLike;
export type BotTarget = { host: string; port: number; version: string };

type Session = { bot: BotLike; lines: string[]; cursor: number; alive: boolean; ended: Promise<void>; waiters: Set<() => void> };

const NAME = /^[A-Za-z0-9_]{3,16}$/;
const MAX_LINES = 1000;

const str = (req: Request, key: string): string => {
  const v = req[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${req.op} needs ${key}`);
  return v;
};
const ms = (req: Request, key: string, dflt: number): number => {
  const v = req[key] ?? dflt;
  if (typeof v !== 'number' || !(v > 0) || v > 600_000) throw new Error(`${req.op}: ${key} must be 1..600000 ms`);
  return v;
};
const reason = (r: unknown) => (typeof r === 'string' ? r : r instanceof Error ? r.message : JSON.stringify(r));
const notify = (s: Session) => {
  for (const w of [...s.waiters]) w();
};

export function botOps(create: CreateBot, t: BotTarget): Record<string, Handler> {
  const bots = new Map<string, Session>();
  const joining = new Set<string>();
  const get = (req: Request) => {
    const name = str(req, 'name');
    const s = bots.get(name);
    if (!s) throw new Error(`no bot ${name}; bot.join it first`);
    return [name, s] as const;
  };
  const quit = async (name: string, s: Session) => {
    bots.delete(name);
    s.bot.quit();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([s.ended, new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
  };
  return {
    // Resolves once the bot has spawned in the world.
    'bot.join': async (req) => {
      const name = str(req, 'name');
      if (!NAME.test(name)) throw new Error(`bad bot name ${name}: 3-16 letters, digits or _`);
      if (bots.has(name) || joining.has(name)) throw new Error(`bot ${name} is already joined`);
      const timeout = ms(req, 'timeoutMs', 30_000);
      joining.add(name);
      try {
        const bot = create({ host: t.host, port: t.port, username: name, version: t.version, auth: 'offline' });
        let endResolve = () => {};
        const s: Session = { bot, lines: [], cursor: 0, alive: true, ended: new Promise((r) => (endResolve = r)), waiters: new Set() };
        bot.on('messagestr', (text) => {
          s.lines.push(text);
          if (s.lines.length > MAX_LINES) {
            s.lines.shift();
            s.cursor = Math.max(0, s.cursor - 1);
          }
          notify(s);
        });
        await new Promise<void>((resolve, reject) => {
          let joined = false;
          const timer = setTimeout(() => {
            bot.quit();
            reject(new Error(`bot ${name} did not spawn within ${timeout}ms`));
          }, timeout);
          const onEnd = (why: unknown) => {
            if (!s.alive) return;
            s.alive = false;
            if (bots.get(name) === s) bots.delete(name);
            notify(s);
            endResolve();
            if (!joined) {
              clearTimeout(timer);
              reject(new Error(`bot ${name} could not join: ${reason(why)}`));
            }
          };
          for (const ev of ['end', 'kicked', 'error'] as const) bot.once(ev, onEnd);
          bot.once('spawn', () => {
            joined = true;
            clearTimeout(timer);
            bots.set(name, s);
            resolve();
          });
        });
      } finally {
        joining.delete(name);
      }
      return { name };
    },
    'bot.chat': async (req) => {
      const [, s] = get(req);
      s.bot.chat(str(req, 'message'));
      return {};
    },
    // The first line from the cursor on that matches; the cursor moves past it.
    'bot.waitMessage': async (req) => {
      const [name, s] = get(req);
      const flags = req.flags ?? '';
      if (typeof flags !== 'string' || !/^[imsu]*$/.test(flags)) throw new Error('bot.waitMessage: flags may hold only i, m, s and u');
      const re = new RegExp(str(req, 'regex'), flags);
      const timeout = ms(req, 'timeoutMs', 10_000);
      const deadline = Date.now() + timeout;
      for (;;) {
        for (let i = s.cursor; i < s.lines.length; i++) {
          if (re.test(s.lines[i])) {
            s.cursor = i + 1;
            return { line: s.lines[i] };
          }
        }
        s.cursor = s.lines.length;
        if (!s.alive) throw new Error(`bot ${name} left the server`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`bot ${name}: no message matching /${re.source}/ within ${timeout}ms`);
        await new Promise<void>((r) => {
          const done = () => {
            clearTimeout(timer);
            s.waiters.delete(done);
            r();
          };
          const timer = setTimeout(done, left);
          s.waiters.add(done);
        });
      }
    },
    'bot.quit': async (req) => {
      const [name, s] = get(req);
      await quit(name, s);
      return {};
    },
    // Between two checks of the suite: every bot leaves.
    'bot.quitAll': async () => {
      const all = [...bots];
      await Promise.all(all.map(([n, s]) => quit(n, s)));
      return { quit: all.map(([n]) => n).sort() };
    },
    'bot.list': async () => ({ bots: [...bots.keys()].sort() }),
  };
}
