// Unit tests for the path guard's rules (src/guard/paths.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, MAX_BYTES } from '../../src/guard/paths.ts';

const allowedPublic = [
  'bin/mc',
  'bin/path-guard',
  'hooks/pre-commit',
  'src/guard/paths.ts',
  'test/unit/mc.bats',
  'docker/server.Dockerfile',
  'templates/postmortem.md',
  'template/.gitignore',
  'docs/leak-response.md',
  '.github/workflows/test.yml',
  '.claude/settings.json',
  'Makefile',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'AGENTS.md',
  'CLAUDE.md',
  '.gitignore',
  '.env.example',
];

for (const path of allowedPublic) {
  test(`public allows ${path}`, () => {
    assert.equal(classify(path, 100, 'public'), null);
  });
}

const notAllowlisted = ['README.txt', 'notes/x.md', 'lib/x.ts', '.claude/settings.local.json', '.omc/plans/p.md', 'node_modules/x/index.js', 'server.properties'];

for (const path of notAllowlisted) {
  test(`public refuses ${path} outside the allowlist`, () => {
    assert.equal(classify(path, 100, 'public'), 'not in the public allowlist');
  });
}

// Each deny rule, at the root and nested inside an allowlisted directory.
const publicDeny: [string, string][] = [
  ['server/x.yml', 'denied: server/'],
  ['test/fixtures/server/x.yml', 'denied: server/'],
  ['backups/20261031/remote/a.yml', 'denied: backups/'],
  ['test/backups/a.yml', 'denied: backups/'],
  ['.mc/remote/abc', 'denied: .mc/'],
  ['src/.mc/abc', 'denied: .mc/'],
  ['.dev/seed-1/x', 'denied: .dev/'],
  ['docs/.dev/x', 'denied: .dev/'],
  ['checks/1-motd/test.ts', 'denied: checks/'],
  ['test/checks/x.ts', 'denied: checks/'],
  ['plugins/Essentials/config.yml', 'denied: plugins/'],
  ['test/plugins/a.yml', 'denied: plugins/'],
  ['world/level.dat', 'denied: world*/'],
  ['world_nether/level.dat', 'denied: world*/'],
  ['test/world_the_end/x', 'denied: world*/'],
  ['test/data.db', 'denied: *.db'],
  ['test/data.sqlite', 'denied: *.sqlite'],
  ['test/data.mv.db', 'denied: *.mv.db'],
  ['test/server.jar', 'denied: *.jar'],
  ['purpur.jar', 'denied: *.jar'],
  ['.env', 'denied: .env'],
  ['.env.local', 'denied: .env'],
  ['test/.env', 'denied: .env'],
  ['docs/.env.prod', 'denied: .env'],
];

for (const [path, reason] of publicDeny) {
  test(`public refuses ${path}`, () => {
    assert.equal(classify(path, 100, 'public'), reason);
  });
}

test('deny rules match whole segments only', () => {
  assert.equal(classify('src/servers/x.ts', 100, 'public'), null);
  assert.equal(classify('src/check/x.ts', 100, 'public'), null);
  assert.equal(classify('docs/plugins.md', 100, 'public'), null);
  assert.equal(classify('docs/db.md', 100, 'public'), null);
});

test('public cap: exactly 512 KB passes, one byte more is refused', () => {
  assert.equal(MAX_BYTES, 512 * 1024);
  assert.equal(classify('test/big.txt', 512 * 1024, 'public'), null);
  assert.equal(classify('test/big.txt', 512 * 1024 + 1, 'public'), `${512 * 1024 + 1} bytes, over the 524288-byte cap`);
});

test('the deny reason wins over the cap', () => {
  assert.equal(classify('server/x.yml', MAX_BYTES + 1, 'public'), 'denied: server/');
});

test('private allows server files, jars and anything outside the public allowlist', () => {
  for (const path of ['server/server.properties', 'server/plugins/Essentials/config.yml', 'server/purpur.jar', 'checks/1-motd/test.ts', 'sync-data.txt']) {
    assert.equal(classify(path, 10 * MAX_BYTES, 'private'), null, path);
  }
});

const privateDeny: [string, string][] = [
  ['server/plugins/LuckPerms/luckperms.db', 'denied: *.db'],
  ['server/plugins/X/data.sqlite', 'denied: *.sqlite'],
  ['server/plugins/X/data.mv.db', 'denied: *.mv.db'],
  ['server/plugins/X/data.h2.db', 'denied: *.h2.db'],
  ['server/plugins/Essentials/userdata/abc.yml', 'denied: userdata/'],
  ['server/world/playerdata/abc.dat', 'denied: playerdata/'],
  ['.env', 'denied: .env'],
  ['.env.gitea', 'denied: .env'],
];

for (const [path, reason] of privateDeny) {
  test(`private refuses ${path}`, () => {
    assert.equal(classify(path, 100, 'private'), reason);
  });
}

test('.env.example is allowed in both profiles', () => {
  assert.equal(classify('.env.example', 100, 'public'), null);
  assert.equal(classify('.env.example', 100, 'private'), null);
});
