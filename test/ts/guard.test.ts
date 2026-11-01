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

const notAllowlisted = ['README.txt', 'notes/x.md', 'lib/x.ts', '.claude/settings.local.json', '.omc/plans/p.md', 'node_modules/x/index.js', 'bukkit.yml'];

for (const path of notAllowlisted) {
  test(`public refuses ${path} outside the allowlist`, () => {
    assert.equal(classify(path, 100, 'public'), 'not in the public allowlist');
  });
}

// Each deny rule, at the root and nested inside an allowlisted directory,
// in mixed case.
const publicDeny: [string, string][] = [
  ['server/x.yml', 'denied: server/'],
  ['test/fixtures/server/x.yml', 'denied: server/'],
  ['docs/Server/a.yml', 'denied: server/'],
  ['backups/20261031/remote/a.yml', 'denied: backups/'],
  ['test/backups/a.yml', 'denied: backups/'],
  ['.mc/remote/abc', 'denied: .mc/'],
  ['src/.MC/abc', 'denied: .mc/'],
  ['.dev/seed-1/x', 'denied: .dev/'],
  ['docs/.dev/x', 'denied: .dev/'],
  ['checks/1-motd/test.ts', 'denied: checks/'],
  ['test/Checks/x.ts', 'denied: checks/'],
  ['plugins/Essentials/config.yml', 'denied: plugins/'],
  ['docs/Plugins/a.yml', 'denied: plugins/'],
  ['world/level.dat', 'denied: world*/'],
  ['world_nether/level.dat', 'denied: world*/'],
  ['docs/WORLD/l.dat', 'denied: world*/'],
  ['test/fixtures/userdata/u.yml', 'denied: userdata/'],
  ['test/PlayerData/u.dat', 'denied: playerdata/'],
  ['test/data.mv.db', 'denied: *.mv.db'],
  ['test/fixtures/Luckperms.MV.DB', 'denied: *.mv.db'],
  ['test/data.h2.db', 'denied: *.h2.db'],
  ['test/data.db', 'denied: *.db*'],
  ['test/fixtures/b.DB', 'denied: *.db*'],
  ['docs/foo.Db', 'denied: *.db*'],
  ['test/fixtures/d.db-wal', 'denied: *.db*'],
  ['test/x.db-shm', 'denied: *.db*'],
  ['test/x.db.bak', 'denied: *.db*'],
  ['test/data.sqlite', 'denied: *.sqlite*'],
  ['docs/x.SQLITE', 'denied: *.sqlite*'],
  ['test/fixtures/c.sqlite3', 'denied: *.sqlite*'],
  ['test/fixtures/level.dat', 'denied: *.dat'],
  ['test/level.dat_old', 'denied: *.dat_old'],
  ['test/fixtures/r.0.0.mca', 'denied: *.mca'],
  ['test/house.nbt', 'denied: *.nbt'],
  ['test/usercache.json', 'denied: usercache.json'],
  ['docs/backup.zip', 'denied: *.zip'],
  ['docs/backup.tar', 'denied: *.tar*'],
  ['docs/backup.tar.xz', 'denied: *.tar*'],
  ['docs/latest.log.gz', 'denied: *.gz'],
  ['test/server.jar', 'denied: *.jar*'],
  ['purpur.jar', 'denied: *.jar*'],
  ['test/fixtures/a.JAR', 'denied: *.jar*'],
  ['docs/foo.JAR', 'denied: *.jar*'],
  ['test/fixtures/a.jar.disabled', 'denied: *.jar*'],
  ['test/fixtures/server.properties', 'denied: server.properties'],
  ['test/ops.json', 'denied: ops.json'],
  ['test/whitelist.json', 'denied: whitelist.json'],
  ['test/banned-players.json', 'denied: banned-*.json'],
  ['test/banned-ips.json', 'denied: banned-*.json'],
  ['.env', 'denied: .env*'],
  ['.env.local', 'denied: .env*'],
  ['test/.env', 'denied: .env*'],
  ['test/.ENV', 'denied: .env*'],
  ['test/.envrc', 'denied: .env*'],
  ['docs/.env.prod', 'denied: .env*'],
  ['docs/.ENV.EXAMPLE', 'denied: .env*'],
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
  assert.equal(classify('docs/data.md', 100, 'public'), null);
});

test('public cap: exactly 512 KB passes, one byte more is refused', () => {
  assert.equal(MAX_BYTES, 512 * 1024);
  assert.equal(classify('test/big.txt', 512 * 1024, 'public'), null);
  assert.equal(classify('test/big.txt', 512 * 1024 + 1, 'public'), `${512 * 1024 + 1} bytes, over the 524288-byte cap`);
});

test('the deny reason wins over the cap', () => {
  assert.equal(classify('server/x.yml', MAX_BYTES + 1, 'public'), 'denied: server/');
});

test('private allows server configs, jars and anything outside the public allowlist', () => {
  const paths = [
    'server/server.properties',
    'server/ops.json',
    'server/whitelist.json',
    'server/banned-players.json',
    'server/plugins/Essentials/config.yml',
    'server/purpur.jar',
    'server/plugins/Old.jar.disabled',
    'checks/1-motd/test.ts',
    'sync-data.txt',
  ];
  for (const path of paths) {
    assert.equal(classify(path, 10 * MAX_BYTES, 'private'), null, path);
  }
});

const privateDeny: [string, string][] = [
  ['server/plugins/Essentials/userdata/abc.yml', 'denied: userdata/'],
  ['server/world/playerdata/abc.dat', 'denied: playerdata/'],
  ['server/plugins/X/data.mv.db', 'denied: *.mv.db'],
  ['server/plugins/LuckPerms/Luckperms.MV.DB', 'denied: *.mv.db'],
  ['server/plugins/X/data.h2.db', 'denied: *.h2.db'],
  ['server/plugins/LuckPerms/luckperms.db', 'denied: *.db*'],
  ['server/plugins/X/data.DB', 'denied: *.db*'],
  ['server/plugins/X/data.db-wal', 'denied: *.db*'],
  ['server/plugins/X/data.sqlite', 'denied: *.sqlite*'],
  ['server/plugins/X/data.sqlite3', 'denied: *.sqlite*'],
  ['server/world/level.dat', 'denied: *.dat'],
  ['server/world/level.dat_old', 'denied: *.dat_old'],
  ['server/world/region/r.0.0.mca', 'denied: *.mca'],
  ['server/world/generated/minecraft/structures/house.nbt', 'denied: *.nbt'],
  ['server/usercache.json', 'denied: usercache.json'],
  ['server/plugins/X/backup.zip', 'denied: *.zip'],
  ['server/plugins/X/backup.tar.gz', 'denied: *.tar*'],
  ['server/logs/2026-10-31-1.log.gz', 'denied: *.gz'],
  ['.env', 'denied: .env*'],
  ['.env.gitea', 'denied: .env*'],
  ['.envrc', 'denied: .env*'],
  ['server/.ENV', 'denied: .env*'],
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
