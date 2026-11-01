// Unit tests for the relay's bot sessions (src/relay/bots.ts) with a fake
// mineflayer: join on spawn, sessions kept by name, chat, waitMessage from a
// cursor over buffered lines, quit, quitAll and list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handle } from '../../src/relay/daemon.ts';
import { botOps, type BotLike, type CreateBot } from '../../src/relay/bots.ts';

class FakeBot extends EventEmitter {
  said: string[] = [];
  quits = 0;
  chat(text: string) {
    this.said.push(text);
  }
  quit() {
    this.quits++;
    setImmediate(() => this.emit('end', 'quit'));
  }
}

// spawn: 'now' spawns on the next tick, 'never' doesn't, or a kick reason.
function fake(spawn: 'now' | 'never' | string = 'now') {
  const made: { opts: Parameters<CreateBot>[0]; bot: FakeBot }[] = [];
  const create: CreateBot = (opts) => {
    const bot = new FakeBot();
    made.push({ opts, bot });
    setImmediate(() => (spawn === 'now' ? bot.emit('spawn') : spawn !== 'never' && bot.emit('kicked', spawn)));
    return bot as unknown as BotLike;
  };
  return { made, ops: botOps(create, { host: 'mc-x-dev-server', port: 25565, version: '26.1' }) };
}

const ask = (ops: Parameters<typeof handle>[1], req: object) => handle(JSON.stringify(req), ops);

test('bot.join resolves once the bot spawns, offline on the server; the session stays by name', async () => {
  const { made, ops } = fake();
  assert.deepEqual(await ask(ops, { op: 'bot.join', name: 'Steve' }), { ok: true, name: 'Steve' });
  assert.deepEqual(made[0].opts, { host: 'mc-x-dev-server', port: 25565, username: 'Steve', version: '26.1', auth: 'offline' });
  assert.deepEqual(await ask(ops, { op: 'bot.list' }), { ok: true, bots: ['Steve'] });
  assert.deepEqual(await ask(ops, { op: 'bot.join', name: 'Steve' }), { ok: false, error: 'bot Steve is already joined' });
  assert.deepEqual(await ask(ops, { op: 'bot.join', name: 'a b' }), { ok: false, error: 'bad bot name a b: 3-16 letters, digits or _' });
  assert.deepEqual(await ask(ops, { op: 'bot.chat', name: 'Steve', message: '/me waves' }), { ok: true });
  assert.deepEqual(made[0].bot.said, ['/me waves']);
  assert.deepEqual(await ask(ops, { op: 'bot.chat', name: 'Alex', message: 'hi' }), { ok: false, error: 'no bot Alex; bot.join it first' });
});

test('bot.join fails with the kick reason, or after its timeout, and keeps no session', async () => {
  let { ops } = fake('You are banned');
  assert.deepEqual(await ask(ops, { op: 'bot.join', name: 'Steve' }), { ok: false, error: 'bot Steve could not join: You are banned' });
  assert.deepEqual(await ask(ops, { op: 'bot.list' }), { ok: true, bots: [] });
  ({ ops } = fake('never'));
  assert.deepEqual(await ask(ops, { op: 'bot.join', name: 'Steve', timeoutMs: 50 }), { ok: false, error: 'bot Steve did not spawn within 50ms' });
  assert.deepEqual(await ask(ops, { op: 'bot.join', name: 'Steve', timeoutMs: 0 }), { ok: false, error: 'bot.join: timeoutMs must be 1..600000 ms' });
});

test('bot.waitMessage reads buffered lines from a cursor, waits for new ones, and times out', async () => {
  const { made, ops } = fake();
  await ask(ops, { op: 'bot.join', name: 'Steve' });
  const bot = made[0].bot;
  // A reply that arrived before the call (e.g. between two CLI calls) counts.
  bot.emit('messagestr', 'Balance: 10');
  bot.emit('messagestr', 'Balance: 25');
  assert.deepEqual(await ask(ops, { op: 'bot.waitMessage', name: 'Steve', regex: 'Balance: \\d+' }), { ok: true, line: 'Balance: 10' });
  assert.deepEqual(await ask(ops, { op: 'bot.waitMessage', name: 'Steve', regex: 'balance: \\d+', flags: 'i' }), { ok: true, line: 'Balance: 25' });
  // Nothing left past the cursor: wait for the next line.
  setTimeout(() => bot.emit('messagestr', 'Balance: 40'), 20);
  assert.deepEqual(await ask(ops, { op: 'bot.waitMessage', name: 'Steve', regex: 'Balance' }), { ok: true, line: 'Balance: 40' });
  assert.deepEqual(await ask(ops, { op: 'bot.waitMessage', name: 'Steve', regex: 'Balance', timeoutMs: 30 }), { ok: false, error: 'bot Steve: no message matching /Balance/ within 30ms' });
  assert.deepEqual(await ask(ops, { op: 'bot.waitMessage', name: 'Steve', regex: 'x', flags: 'g' }), { ok: false, error: 'bot.waitMessage: flags may hold only i, m, s and u' });
  // Kicked while waiting: the wait ends with the reason it left.
  setTimeout(() => bot.emit('kicked', 'Server closed'), 20);
  assert.deepEqual(await ask(ops, { op: 'bot.waitMessage', name: 'Steve', regex: 'never' }), { ok: false, error: 'bot Steve left the server' });
  assert.deepEqual(await ask(ops, { op: 'bot.list' }), { ok: true, bots: [] });
});

test('bot.quit and bot.quitAll make bots leave and wait for it', async () => {
  const { made, ops } = fake();
  for (const name of ['Steve', 'Alex', 'Notch']) await ask(ops, { op: 'bot.join', name });
  assert.deepEqual(await ask(ops, { op: 'bot.quit', name: 'Steve' }), { ok: true });
  assert.equal(made[0].bot.quits, 1);
  assert.deepEqual(await ask(ops, { op: 'bot.quitAll' }), { ok: true, quit: ['Alex', 'Notch'] });
  assert.deepEqual(await ask(ops, { op: 'bot.list' }), { ok: true, bots: [] });
  assert.deepEqual(await ask(ops, { op: 'bot.quitAll' }), { ok: true, quit: [] });
});
