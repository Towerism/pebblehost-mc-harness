// Minecraft RCON client. A packet is little-endian [length][id][type] then the
// body and two NUL bytes; length counts everything after itself.
import { connect, type Socket } from 'node:net';

export const AUTH = 3;
export const EXEC = 2;
// Vanilla answers a type it doesn't know with "Unknown request <hex>" under the
// same id, after the replies to earlier packets: the end marker of a reply
// that the server split into several packets.
export const MARKER = 200;
// Vanilla reads each request into a 1460-byte buffer.
export const MAX_BODY = 1446;

export type Frame = { id: number; type: number; body: Buffer };

export class RconError extends Error {}

export function encode(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + b.length);
  out.writeInt32LE(10 + b.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  b.copy(out, 12);
  return out;
}

// Cuts a byte stream into frames, keeping a partial frame for the next chunk.
export class Decoder {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (len < 10 || len > 1 << 20) throw new RconError(`bad packet length ${len}`);
      if (this.buf.length < 4 + len) break;
      out.push({ id: this.buf.readInt32LE(4), type: this.buf.readInt32LE(8), body: this.buf.subarray(12, 2 + len) });
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

// One authenticated connection; commands run one at a time. Any socket error,
// close or timeout marks it closed and fails what is pending.
export class Rcon {
  closed = false;
  private dec = new Decoder();
  private id = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private onFrame: (f: Frame) => void = () => {};
  private onEnd: (e: Error) => void = () => {};
  private sock: Socket;
  private timeoutMs: number;

  private constructor(sock: Socket, timeoutMs: number) {
    this.sock = sock;
    this.timeoutMs = timeoutMs;
    sock.on('data', (chunk) => {
      try {
        for (const f of this.dec.push(chunk)) this.onFrame(f);
      } catch (e) {
        this.end(e as Error);
      }
    });
    sock.on('error', (e) => this.end(new RconError(`rcon: ${e.message}`)));
    sock.on('close', () => this.end(new RconError('rcon: connection closed')));
  }

  static async connect(host: string, port: number, password: string, timeoutMs = 10_000): Promise<Rcon> {
    const r = new Rcon(connect({ host, port }), timeoutMs);
    const [ok] = await r.send([encode(++r.id, AUTH, password)], (f) => f.type === EXEC);
    if (ok.id === -1) {
      r.close();
      throw new RconError('rcon: authentication failed');
    }
    return r;
  }

  command(cmd: string): Promise<string> {
    if (Buffer.byteLength(cmd) > MAX_BODY) return Promise.reject(new RconError(`rcon: command over ${MAX_BODY} bytes`));
    const run = async () => {
      const id = ++this.id;
      const marker = ++this.id;
      const frames = await this.send([encode(id, EXEC, cmd), encode(marker, MARKER, '')], (f) => f.id === marker);
      return Buffer.concat(frames.filter((f) => f.id === id).map((f) => f.body)).toString('utf8');
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  close(): void {
    this.end(new RconError('rcon: closed'));
  }

  private end(e: Error) {
    this.closed = true;
    this.sock.destroy();
    this.onEnd(e);
  }

  // Write the packets, then collect frames until `last` matches one.
  private send(packets: Buffer[], last: (f: Frame) => boolean): Promise<Frame[]> {
    if (this.closed) return Promise.reject(new RconError('rcon: connection closed'));
    return new Promise((resolve, reject) => {
      const frames: Frame[] = [];
      const timer = setTimeout(() => this.end(new RconError(`rcon: no reply within ${this.timeoutMs}ms`)), this.timeoutMs);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        this.onFrame = () => {};
        this.onEnd = () => {};
        fn();
      };
      this.onFrame = (f) => {
        frames.push(f);
        if (last(f)) done(() => resolve(frames));
      };
      this.onEnd = (e) => done(() => reject(e));
      for (const p of packets) this.sock.write(p);
    });
  }
}
