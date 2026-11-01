// Harness API for bare-text checks, imported as '#harness/unit': `test`, and
// bareText(file, path, literal), which asserts that the value at `path` in
// server/<file> is exactly `literal`. .properties files take a key, YAML a
// dotted path to a scalar. Nothing else is allowed in a bare-text check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findYaml } from '../dev/overrides.ts';

export { test } from 'node:test';

// A YAML line's scalar value: plain, 'single' or "double" quoted; null for
// anything else (block scalars, flow collections, anchors, nested maps).
export function yamlScalar(line: string): string | null {
  const v = line.slice(line.indexOf(':') + 1).trim();
  if (v.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(v);
    return m ? m[1].replace(/''/g, "'") : null;
  }
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(v);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return null;
    }
  }
  const plain = v.replace(/\s+#.*$/, '');
  return plain === '' || /^[|>&*![{]/.test(plain) ? null : plain;
}

export function readValue(text: string, file: string, path: string): string {
  const lines = text.replace(/\r$/gm, '').split('\n');
  if (file.endsWith('.properties')) {
    const line = lines.find((l) => !l.trimStart().startsWith('#') && l.includes('=') && l.slice(0, l.indexOf('=')).trim() === path);
    if (line === undefined) throw new Error(`${file}: no key ${path}`);
    return line.slice(line.indexOf('=') + 1);
  }
  const at = findYaml(lines, path);
  if (at < 0) throw new Error(`${file}: no ${path}`);
  const v = yamlScalar(lines[at]);
  if (v === null) throw new Error(`${file}: ${path} is not a single-line scalar, so it is not bare text`);
  return v;
}

export function bareText(file: string, path: string, literal: string): void {
  if (!process.env.MC_HOME) throw new Error('MC_HOME is not set: run checks with bin/check run');
  if (file.startsWith('/') || file.split('/').includes('..')) throw new Error(`bad server path ${file}`);
  assert.equal(readValue(readFileSync(join(process.env.MC_HOME, 'server', file), 'utf8'), file, path), literal, `${file} ${path}`);
}
