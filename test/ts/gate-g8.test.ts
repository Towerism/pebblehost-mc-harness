// bin/check gate end to end on real files: G8 refuses a check that is not the
// bare-text shape and a literal holding a tag, after a real red and green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, commit, git, project } from './project.ts';

const records = (root: string) => {
  git(root, 'add', '.verify');
  git(root, 'commit', '-q', '-m', 'records');
};

test('G8 end to end: a check that is not the bare-text shape, and a literal holding a tag, are refused after a real red and green', () => {
  const root = project({
    'checks/3-fs/profile.json': '{"kind":"bare-text"}\n',
    'checks/3-fs/fs.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('reads', () => assert.match(readFileSync('server/config.yml', 'utf8'), /Fixed/));\n",
    'checks/3-tag/profile.json': '{"kind":"bare-text"}\n',
    'checks/3-tag/tag.test.ts': "import { test, bareText } from '#harness/unit';\ntest('tag', () => bareText('config.yml', 'crate.name', '<red>Fixed'));\n",
  });
  assert.equal(check(root, {}, 'run', '3-fs').status, 1);
  assert.equal(check(root, {}, 'run', '3-tag').status, 1);
  commit(root, { 'server/config.yml': "crate:\n  name: '<red>Fixed'\n" });
  assert.equal(check(root, {}, 'run', '3-fs').status, 0);
  assert.equal(check(root, {}, 'run', '3-tag').status, 0);
  records(root);
  let r = check(root, {}, 'gate', '3-fs');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /G8: fs\.test\.ts: not a bare-text check: unexpected "\." at 4:27/);
  r = check(root, {}, 'gate', '3-tag');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /G8: tag\.test\.ts: literal "<red>Fixed" holds a <tag>/);
});
