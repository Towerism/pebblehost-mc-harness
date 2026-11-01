// checks/<id>/profile.json: what a check needs from the server.
//   kind       "e2e" or "bare-text"
//   fixtures   directories under checks/<id>/ laid over the server tree on
//              the volume's first boot (bin/dev --fixtures)
//   data       fixture paths that are plugin data (reset by a restart, not a
//              copy); *.db and *.sqlite files always are
//   needs      "console" and/or "bot": what the check talks to
//   restart    the check calls dev.restart() or dev.reset()
//   exclusive  the check gets a pod of its own
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from '../dev/docker.ts';
import type { Kind } from './record.ts';

export type Need = 'console' | 'bot';
export type Profile = { kind: Kind; fixtures: string[]; data: string[]; needs: Need[]; restart: boolean; exclusive: boolean };

const KEYS = ['kind', 'fixtures', 'data', 'needs', 'restart', 'exclusive'];
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const relative = (s: string) => s !== '' && !s.startsWith('/') && !s.split('/').includes('..');

export function readProfile(root: string, id: string): Profile {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) fail(`bad check id ${id}`);
  const f = join(root, 'checks', id, 'profile.json');
  if (!existsSync(f)) fail(`no checks/${id}/profile.json`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    fail(`checks/${id}/profile.json is not JSON`);
  }
  const bad = (why: string): never => fail(`checks/${id}/profile.json: ${why}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('not an object');
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) bad(`unknown key ${k}`);
  const p: Profile = { kind: raw.kind as Kind, fixtures: (raw.fixtures ?? []) as string[], data: (raw.data ?? []) as string[], needs: (raw.needs ?? []) as Need[], restart: (raw.restart ?? false) as boolean, exclusive: (raw.exclusive ?? false) as boolean };
  if (p.kind !== 'e2e' && p.kind !== 'bare-text') bad('kind must be "e2e" or "bare-text"');
  if (!strings(p.fixtures) || !p.fixtures.every(relative)) bad('fixtures must be directories relative to the check');
  if (!strings(p.data) || !p.data.every(relative)) bad('data must be paths relative to the server root');
  if (!strings(p.needs) || !p.needs.every((n) => n === 'console' || n === 'bot')) bad('needs may hold only "console" and "bot"');
  if (typeof p.restart !== 'boolean' || typeof p.exclusive !== 'boolean') bad('restart and exclusive must be true or false');
  if (p.kind === 'bare-text' && (p.fixtures.length || p.data.length || p.needs.length || p.restart || p.exclusive)) bad('a bare-text check takes no fixtures, data, needs, restart or exclusive');
  return p;
}

// The check's fixture directories, absolute.
export function fixtureDirs(root: string, id: string, p: Profile): string[] {
  return p.fixtures.map((f) => {
    const dir = join(root, 'checks', id, f);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`checks/${id}/profile.json: fixtures ${f} is not a directory in the check`);
    return dir;
  });
}

// Whether a fixture file (relative to the server root) is plugin data.
export function isData(rel: string, p: Profile): boolean {
  return /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i.test(rel) || p.data.some((d) => rel === d || rel.startsWith(`${d.replace(/\/$/, '')}/`));
}
