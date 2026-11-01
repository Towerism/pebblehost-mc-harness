// Harness API for bare-text checks, imported as '#harness/unit': `test`, and
// bareText(file, path, literal), which asserts that the value at `path` in
// the committed server/<file> is exactly `literal`. .properties files take a
// key, YAML a dotted path to a scalar. Nothing else is allowed in a
// bare-text check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

// The file as committed at MC_COMMIT (the run's commit), never the working
// tree: an untracked or ignored file is not bare text the fix can commit.
export function bareText(file: string, path: string, literal: string): void {
  const { MC_HOME: home, MC_COMMIT: commit } = process.env;
  if (!home || !commit) throw new Error('MC_HOME or MC_COMMIT is not set: run checks with bin/check run');
  if (file.startsWith('/') || file.split('/').includes('..')) throw new Error(`bad server path ${file}`);
  const r = spawnSync('git', ['-C', home, 'show', `${commit}:server/${file}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`server/${file} is not tracked at ${commit.slice(0, 12)}`);
  assert.equal(readValue(r.stdout, file, path), literal, `${file} ${path}`);
}
