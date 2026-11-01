// The part of mineflayer 4.39.0 the relay uses (bots.ts BotLike, CreateBot).
// mineflayer is installed only in the relay image (docker/relay/package.json),
// not in the harness checkout.
declare module 'mineflayer' {
  export function createBot(opts: { host: string; port: number; username: string; version: string; auth: 'offline' }): {
    on(event: 'messagestr', fn: (text: string) => void): unknown;
    once(event: 'spawn', fn: () => void): unknown;
    once(event: 'end' | 'kicked' | 'error', fn: (reason: unknown) => void): unknown;
    chat(text: string): void;
    quit(): void;
  };
}
