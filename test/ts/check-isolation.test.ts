// bin/check run cannot be steered from outside the committed check: the
// caller's env, a package.json remapping #harness/*, extra files in a
// bare-text check, and untracked server files all fail to make a check pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readRecords } from '../../src/check/record.ts';
import { check, commit, E2E, project, write } from './project.ts';

test('a check sees only an allow-listed env: NODE_OPTIONS cannot preload code that neuters asserts', () => {
  const root = project({ ...E2E, 'checks/3-motd/a.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(process.env.SNEAKY ?? 'unset', 'set'));\n" });
  write(root, { 'neuter.cjs': "const a = require('node:assert'); a.strict.equal = () => {}; a.equal = () => {};\n" });
  const r = check(root, { NODE_OPTIONS: `--require ${join(root, 'neuter.cjs')}`, SNEAKY: 'set' }, 'run', '3-motd');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(readRecords(root, 3)[0].pass, false);
});

test('#harness/* always resolves to this harness: a project or check package.json cannot remap it', () => {
  const fake = "export { test } from 'node:test';\nexport function bareText() {}\n";
  const bare = (lit: string) => `import { test, bareText } from '#harness/unit';\ntest('name', () => bareText('config.yml', 'crate.name', '${lit}'));\n`;
  // An uncommitted root package.json pointing #harness/* at a stub that always passes.
  const root = project({ 'checks/3-crate/profile.json': '{"kind":"bare-text"}\n', 'checks/3-crate/crate.test.ts': bare('Wrong') });
  write(root, { 'package.json': '{"type":"module","imports":{"#harness/*":"./stub/*.ts"}}\n', 'stub/unit.ts': fake });
  let r = check(root, {}, 'run', '3-crate');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /config\.yml crate\.name/);
  // A committed package.json (or any other file) inside a bare-text check is refused.
  commit(root, { 'checks/3-crate/package.json': '{"imports":{"#harness/*":"./unit.ts"}}\n', 'checks/3-crate/unit.ts': fake });
  r = check(root, {}, 'run', '3-crate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /checks\/3-crate is bare-text: only profile\.json and \*\.test\.ts are allowed, not package\.json, unit\.ts/);
  r = check(root, {}, 'run', '3-crate', '--issue', '4');
  assert.equal(readRecords(root, 4).length, 0);
});

test('bareText reads the committed file: an ignored or untracked server file never passes', () => {
  const root = project({ '.gitignore': '.dev/\nserver/data/\n', 'checks/3-data/profile.json': '{"kind":"bare-text"}\n', 'checks/3-data/d.test.ts': "import { test, bareText } from '#harness/unit';\ntest('d', () => bareText('data/d.yml', 'name', 'Fixed'));\n" });
  write(root, { 'server/data/d.yml': 'name: Fixed\n' });
  const r = check(root, {}, 'run', '3-data');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /server\/data\/d\.yml is not tracked at [0-9a-f]{12}/);
});
