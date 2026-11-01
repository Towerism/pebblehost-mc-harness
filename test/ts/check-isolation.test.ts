// bin/check run cannot be steered from outside the committed check: the
// caller's env, a package.json remapping #harness/*, extra files in a
// bare-text check, and untracked server files all fail to make a check pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readRecords } from '../../src/check/record.ts';
import { spawnSync } from 'node:child_process';
import { check, commit, E2E, ENV, git, project, write } from './project.ts';

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

test('only committed files of a check run: an ignored or untracked file in checks/<id> refuses the run', () => {
  for (const kind of ['e2e', 'bare-text']) {
    const t = kind === 'e2e' ? "import { test } from 'node:test';\ntest('ok', () => {});\n" : "import { test, bareText } from '#harness/unit';\ntest('name', () => bareText('config.yml', 'crate.name', 'Vote Crate'));\n";
    const root = project({ '.gitignore': '.dev/\nchecks/3-x/zz.test.ts\n', 'checks/3-x/profile.json': `{"kind":"${kind}"}\n`, 'checks/3-x/a.test.ts': t });
    write(root, { 'checks/3-x/zz.test.ts': "import { test } from 'node:test';\ntest('hidden', () => { throw new Error('fake red'); });\n" });
    let r = check(root, {}, 'run', '3-x');
    assert.equal(r.status, 2, `${kind}: ${r.stdout}`);
    assert.match(r.stderr, /checks\/3-x holds untracked or ignored files; remove them or commit them:\nchecks\/3-x\/zz\.test\.ts/);
    write(root, { '.gitignore': '.dev/\n' });
    commit(root, {});
    r = check(root, {}, 'run', '3-x');
    assert.equal(r.status, 1, `${kind} committed: the hidden test now runs and fails openly`);
    assert.deepEqual(readRecords(root, 3).map((x) => x.pass), [false]);
  }
});

test('bareText ignores replace refs: a replaced blob never makes a red pass', () => {
  const root = project({ 'checks/3-crate/profile.json': '{"kind":"bare-text"}\n', 'checks/3-crate/crate.test.ts': "import { test, bareText } from '#harness/unit';\ntest('name', () => bareText('config.yml', 'crate.name', 'Fixed'));\n" });
  const good = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: "crate:\n  name: 'Fixed'\n", encoding: 'utf8', env: ENV }).stdout.trim();
  git(root, 'replace', git(root, 'rev-parse', 'HEAD:server/config.yml').stdout.trim(), good);
  assert.match(git(root, 'show', 'HEAD:server/config.yml').stdout, /Fixed/);
  const r = check(root, {}, 'run', '3-crate');
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('a run another run interleaves with is flagged concurrent, and a marker set during the run counts as explored', () => {
  const root = project({});
  const log = join(root, 'fakefs/.mc-harness-runs');
  commit(root, {
    ...E2E,
    // Stands in for a parallel bin/check run and a human on the console while this one runs.
    'checks/3-motd/a.test.ts': `import { test } from 'node:test';\nimport { appendFileSync, writeFileSync } from 'node:fs';\ntest('meanwhile', () => {\n  appendFileSync(${JSON.stringify(log)}, 'x issue-3 other 00000000-0000-0000-0000-000000000000\\n');\n  writeFileSync(${JSON.stringify(join(root, 'fakefs/.mc-harness-explored'))}, '');\n});\n`,
  });
  const r = check(root, {}, 'run', '3-motd');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [rec] = readRecords(root, 3);
  assert.deepEqual([rec.runIndex, rec.concurrent, rec.explored], [0, true, true]);
});

test('a check imports only from its own directory: a sibling helper or a relative escape is refused, nothing recorded', () => {
  const root = project({
    'checks/lib/helper.ts': 'export const ok = true;\n',
    'checks/3-a/profile.json': '{"kind":"e2e"}\n',
    'checks/3-a/a.test.ts': "import { test } from 'node:test';\nimport { ok } from '../lib/helper.ts';\ntest('a', () => { if (!ok) throw new Error(); });\n",
    'checks/3-b/profile.json': '{"kind":"e2e"}\n',
    'checks/3-b/b.test.ts': "import { test } from 'node:test';\nimport { ok } from '../../server/x.ts';\ntest('b', () => { if (!ok) throw new Error(); });\n",
    'server/x.ts': 'export const ok = true;\n',
    'checks/3-c/profile.json': '{"kind":"e2e"}\n',
    'checks/3-c/c.test.ts': "import { test } from 'node:test';\nimport { join } from 'node:path';\nimport { ok } from './own.ts';\ntest('c', () => { if (!ok || !join) throw new Error(); });\n",
    'checks/3-c/own.ts': 'export const ok = true;\n',
  });
  for (const [id, spec] of [['3-a', '../lib/helper.ts'], ['3-b', '../../server/x.ts']]) {
    const r = check(root, {}, 'run', id);
    assert.equal(r.status, 2, `${id}: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`imports from outside its directory; nothing recorded\\n.*${spec.replace(/[./]/g, '\\$&')}: a check imports only files in its own directory`));
  }
  // Its own files, node: built-ins: fine.
  const r = check(root, {}, 'run', '3-c');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readRecords(root, 3).length, 1);
});
