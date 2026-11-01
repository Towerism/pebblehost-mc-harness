// Dev-only config changes baked into the image's last layer, so the server
// boots offline. Each override rewrites one key of one file under the server
// tree; a missing file or key is a no-op with a note, never an error.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Override = { file: string; key: string; value: string; why: string };
export type Applied = { file: string; content: string | null; note: string };

export const OVERRIDES: readonly Override[] = [
  { file: 'server.properties', key: 'online-mode', value: 'false', why: 'no Mojang session servers offline' },
];

// Set key=value in a .properties text, keeping every other line as is.
export function setProperty(text: string, key: string, value: string): string | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.slice(0, l.indexOf('=')).trim() === key && !l.trimStart().startsWith('#'));
  if (i < 0) return null;
  lines[i] = `${key}=${value}`;
  return lines.join('\n');
}

// The rewritten files for `cfg` (the server tree minus jars), one per file,
// with every override for it applied in order.
export function applyOverrides(cfg: string, list: readonly Override[] = OVERRIDES): Applied[] {
  const files = new Map<string, Applied>();
  for (const o of list) {
    const path = join(cfg, o.file);
    const prev = files.get(o.file);
    if (!prev && !existsSync(path)) {
      files.set(o.file, { file: o.file, content: null, note: `${o.file} absent: ${o.key} not set` });
      continue;
    }
    if (prev && prev.content === null) continue;
    const text = prev?.content ?? readFileSync(path, 'utf8');
    const next = setProperty(text, o.key, o.value);
    const note = next === null ? `${o.file}: no ${o.key} key, left as is` : `${o.file}: ${o.key}=${o.value} (${o.why})`;
    files.set(o.file, { file: o.file, content: next ?? text, note: prev ? `${prev.note}; ${note}` : note });
  }
  return [...files.values()];
}
