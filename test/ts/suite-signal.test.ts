// bin/check suite under SIGINT/SIGTERM: the suite runs in a child process, so
// its parent can stop it mid-run and remove the suite's pods by label.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../../src/dev/image.ts';
import { ENV, fakeDocker, LABELS, project } from './project.ts';

const BARE = "import { test, bareText } from '#harness/unit';\ntest('name', () => bareText('config.yml', 'crate.name', 'Vote Crate'));\n";

// SIGINT/SIGTERM to the bin/check process alone (not its group) while a
// check runs: the child is killed, suite pods are removed by label, 130/143.
describe('signals', { concurrency: true }, () => {
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  test(`${sig} to bin/check mid-run stops the suite, tears down by label and exits ${code}`, async () => {
    const root = project({ 'checks/3-slow/profile.json': '{"kind":"bare-text"}\n', 'checks/3-slow/a.test.ts': BARE.replace("test('name', () =>", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);\ntest('name', () =>") });
    const c = spawn(join(HARNESS_ROOT, 'bin/check'), ['suite'], { env: { ...ENV, MC_HOME: root, MC_DOCKER: fakeDocker({ FAKE_SERVER: '', FAKE_LABELS: JSON.stringify(LABELS), FAKE_FS: join(root, 'fakefs'), FAKE_REPLY: '', FAKE_LOG: '' }) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (b) => (out += b));
    c.stderr.on('data', (b) => (out += b));
    await new Promise((r) => setTimeout(r, 1000));
    const t0 = Date.now();
    c.kill(sig);
    const status = await new Promise<number | null>((r) => c.on('exit', r));
    assert.equal(status, code, out);
    assert.ok(Date.now() - t0 < 5000, 'stopped promptly, not after the 20s check');
    assert.match(out, new RegExp(`check: ${sig}: stopping the suite`));
    assert.match(out, new RegExp(`suite: ${sig}: removed 0 suite resource\\(s\\)`));
  });
}
});
