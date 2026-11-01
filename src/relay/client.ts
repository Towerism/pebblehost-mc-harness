// Relay client, run with `docker exec -i <relay> node /relay/client.ts`: sends
// the one JSON request read from stdin to the daemon's socket and prints its
// one JSON reply. Exit 0 when the reply is ok, 2 otherwise.
import { connect } from 'node:net';

const TIMEOUT_MS = 60_000;

function done(reply: string): never {
  process.stdout.write(reply.endsWith('\n') ? reply : `${reply}\n`);
  let ok = false;
  try {
    ok = JSON.parse(reply).ok === true;
  } catch {
    // not JSON: a failure
  }
  process.exit(ok ? 0 : 2);
}

const failed = (error: string) => done(JSON.stringify({ ok: false, error }));

let input = '';
for await (const chunk of process.stdin) input += chunk;
const line = input.trim();
if (line === '' || line.includes('\n')) failed('send one JSON request on stdin');

let reply = '';
const sock = connect(process.env.RELAY_SOCKET || '/run/relay.sock');
sock.setEncoding('utf8');
sock.setTimeout(TIMEOUT_MS, () => failed(`relay: no reply within ${TIMEOUT_MS / 1000}s`));
sock.on('connect', () => sock.write(`${line}\n`));
sock.on('data', (s: string) => (reply += s));
sock.on('end', () => (reply ? done(reply) : failed('relay: closed without a reply')));
sock.on('error', (e) => failed(`relay not reachable: ${e.message}`));
