// Harness API for headless players, imported as '#harness/bot'. Bots live in
// the pod's relay (mineflayer, offline mode) and are reached like the console;
// a check's bot calls don't mark the volume explored. The suite makes every
// bot leave between two checks. The live target has no bots (live.ts).
import { docker as d } from '../dev/docker.ts';
import { podOf, relayRequest } from '../dev/pod.ts';
import { onLive, refuseOnLive } from './live.ts';

function pod() {
  if (process.env.MC_TARGET !== undefined && process.env.MC_TARGET !== 'dev') throw new Error(`target ${process.env.MC_TARGET} is not supported`);
  if (!process.env.MC_HOME) throw new Error('MC_HOME is not set: run checks with bin/check run');
  return podOf(process.env.MC_HOME, process.env.MC_POD || 'dev');
}

const call = (req: { op: string } & Record<string, unknown>) => (onLive() ? refuseOnLive(`bot ${req.op.slice(4)}`, 'bot') : relayRequest(pod(), d, req));

export type Bot = {
  name: string;
  // Send a chat line or a /command as this player.
  chat(message: string): Promise<void>;
  // The next chat line this bot received (since its join or the last match)
  // that matches; throws after timeoutMs (default 10s).
  waitMessage(pattern: RegExp, timeoutMs?: number): Promise<string>;
  quit(): Promise<void>;
};

export const bot = {
  // Joins the dev server as `name` and resolves once the player has spawned.
  async join(name: string, timeoutMs = 30_000): Promise<Bot> {
    call({ op: 'bot.join', name, timeoutMs });
    return {
      name,
      async chat(message) {
        call({ op: 'bot.chat', name, message });
      },
      async waitMessage(pattern, waitMs = 10_000) {
        return String(call({ op: 'bot.waitMessage', name, regex: pattern.source, flags: pattern.flags, timeoutMs: waitMs }).line);
      },
      async quit() {
        call({ op: 'bot.quit', name });
      },
    };
  },
  async list(): Promise<string[]> {
    return call({ op: 'bot.list' }).bots as string[];
  },
};
