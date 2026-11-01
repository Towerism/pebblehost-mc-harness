// Unit tests for the red→green gate (src/gate/): every rule and refusal case
// of the plan's table over a fake repo, and the G8 static bare-text check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { RunRecord } from '../../src/check/record.ts';
import { bareTextProblems, literalProblems } from '../../src/gate/bareText.ts';
import { evaluate, type GateRepo } from '../../src/gate/gate.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const c = (n: string) => n.repeat(40);
// A: the red's commit. B: the fix (server change). D: docs after B.
// H: a harness bump on A (no server change). X: unrelated to B.
const A = c('a');
const B = c('b');
const D = c('d');
const H = c('e');
const X = c('f');
const PARENT: Record<string, string> = { [B]: A, [D]: B, [H]: A, [X]: A };
const TREE: Record<string, string> = { [A]: 'tA', [B]: 'tB', [D]: 'tB', [H]: 'tA', [X]: 'tA' };

function repo(o: { head?: string; checkHash?: string; clean?: boolean } = {}): GateRepo {
  const ancestors = (x: string): string[] => (x in PARENT ? [x, ...ancestors(PARENT[x])] : [x]);
  return {
    head: () => o.head ?? D,
    checkHashAt: () => o.checkHash ?? 'k1',
    checkClean: () => o.clean ?? true,
    isAncestor: (a, b) => ancestors(b).includes(a),
    serverChanged: (a, b) => TREE[a] !== TREE[b],
    serverTree: (x) => TREE[x] ?? null,
  };
}

function rec(o: Partial<RunRecord>): RunRecord {
  const commit = o.commit ?? A;
  const treeHash = o.treeHash ?? TREE[commit];
  const harnessHash = o.harnessHash ?? 'h1';
  return { check: '7-x', issue: 7, kind: 'e2e', target: 'dev', pass: false, time: '2026-11-01T00:00:00Z', source: 'archive', commit, treeHash, harnessHash, imageHash: sha(`${treeHash}\n${harnessHash}`), fixturesHash: 'f1', checkHash: 'k1', generation: 'g1', fresh: true, explored: false, containerId: 'c', confirm: false, output: '', ...o, ...(o.imageHash ? {} : { imageHash: sha(`${treeHash}\n${harnessHash}`) }) };
}

const red = rec({});
const green = rec({ pass: true, commit: B, generation: 'g2', fresh: false });

function refused(records: RunRecord[], rule: RegExp, r = repo(), statics: string[] = [], kind: 'e2e' | 'bare-text' = 'e2e') {
  const v = evaluate(records, '7-x', kind, r, statics);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.reasons.some((x) => rule.test(x)), `${rule} not in ${JSON.stringify(v.reasons)}`);
}

test('a fresh red, a fix commit, a rebuilt green: the gate passes and names the pair', () => {
  const v = evaluate([red, green], '7-x', 'e2e', repo());
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual([v.red, v.green], [red, green]);
});

test('refusal cases of the gate table', () => {
  refused([green], /^G1: no passing run|^G1: no failing run/);
  refused([red], /^G1: no passing run of 7-x/);
  refused([green, red], /^G1: no failing run of 7-x before its passing run/);
  refused([red, rec({ pass: true, generation: 'g2' })], /^G3: the green booted a{12}, not a strict descendant/);
  refused([red, rec({ pass: true, commit: H, harnessHash: 'h2' })], /^G4: no server\/ change/);
  // A fixture swapped, or the test edited, after the red: the check's tree id moves.
  refused([red, { ...green, checkHash: 'k2' }], /^G2: the check changed/, repo({ checkHash: 'k2' }));
  refused([{ ...red, checkHash: 'k0' }, green], /^G2: the check changed/);
  refused([red, green], /^G2: checks\/7-x has uncommitted changes/, repo({ clean: false }));
  // A restart of the red's image after the fix commit still carries the red's commit.
  refused([red, rec({ pass: true, generation: 'g1' })], /^G3/);
  refused([red, { ...green, imageHash: sha('forged') }], /^G5: the green record's tree or image hash/);
  // Only source=archive images count: a plain-copy (dir) build has no commit to vouch for.
  refused([{ ...red, source: 'dir' }, green], /^G5: the red image was built from dir, not a commit/);
  refused([red, { ...green, source: 'dir', treeHash: `dir:${'0'.repeat(64)}` }], /^G5: the green image was built from dir, not a commit/);
  refused([red, { ...green, fixturesHash: 'f2' }], /^G6: the fixtures changed/);
  refused([{ ...red, explored: true }, green], /^G9: the red's volume g1 was explored/);
  refused([{ ...red, fresh: false }, green], /^G9: the red ran on volume g1, which bin\/check run --fresh did not make/);
  refused([red, green], /^G7: HEAD does not descend/, repo({ head: X }));
  refused([red, { ...green, target: 'live' as 'dev' }], /^G1: the green run is live\/e2e/);
});

test('a valid pair stays valid after a later harness bump and after reds that do not count', () => {
  const bumped = repo({ head: D });
  assert.equal(evaluate([red, green], '7-x', 'e2e', bumped).ok, true);
  const v = evaluate([red, { ...red, explored: true, time: 'later' }, green], '7-x', 'e2e', bumped);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.red, red);
  // Confirm runs never stand in for the green.
  refused([red, { ...green, confirm: true }], /^G1: no passing run/);
  // Other checks' records are ignored.
  refused([red, { ...green, check: '7-y' }], /^G1: no passing run/);
});

test('bare-text pairs skip the image, fixture and volume rules but need the static check', () => {
  const bred = rec({ kind: 'bare-text', source: 'head', imageHash: 'none', harnessHash: '', fixturesHash: '', generation: '', fresh: false });
  const bgreen = { ...bred, pass: true, commit: B, treeHash: 'tB' };
  assert.equal(evaluate([bred, bgreen], '7-x', 'bare-text', repo()).ok, true);
  refused([bred, bgreen], /^G8: crate\.test\.ts: literal "<red>Vote"/, repo(), ['crate.test.ts: literal "<red>Vote" holds a <tag>'], 'bare-text');
  refused([red, green], /^G1: the red run is dev\/e2e, not dev\/bare-text/, repo(), [], 'bare-text');
});

const OK = `import { test, bareText } from '#harness/unit';

// The vote crate's display name.
test('crate name', () => bareText('plugins/CrateReloaded/crates/vote.yml', 'crate.name', 'Vote Crate'));
test("two", () => {
  bareText("a.yml", "x.y", "It's here");
  bareText('b.yml', 'z', 'Plain');
});
`;

test('G8 accepts only the bare-text shape', () => {
  assert.deepEqual(bareTextProblems(OK), []);
  assert.deepEqual(bareTextProblems("import { bareText, test, } from '#harness/unit'\ntest('a', () => bareText('f', 'p', 'v'))\n"), []);
  const bad: [string, RegExp][] = [
    ["import { dev } from '#harness/dev';\ntest('a', async () => {});\n", /only test and bareText may be imported, not dev/],
    ["import { test, bareText } from '#harness/dev';\ntest('a', () => bareText('f', 'p', 'v'));\n", /imports only from '#harness\/unit'/],
    ["import { test, bareText } from '#harness/unit';\nimport fs from 'node:fs';\ntest('a', () => bareText('f', 'p', 'v'));\n", /expected test at 2:1, found "import"/],
    ["import { test, bareText } from '#harness/unit';\nconst v = 'x';\ntest('a', () => bareText('f', 'p', v));\n", /unexpected "=" at 2:9/],
    ["import { test, bareText } from '#harness/unit';\ntest('a', () => bareText('f', 'p', `v`));\n", /unexpected "`"/],
    ["import { test, bareText } from '#harness/unit';\ntest('a', () => { bareText('f', 'p', 'v'); console.log(1); });\n", /unexpected "\." at 2:51/],
    ["import { test, bareText } from '#harness/unit';\n", /no test\(\.\.\.\)/],
    ["import { test, bareText } from '#harness/unit';\ntest('a', () => bareText('f', 'p', 'v' + 'w'));\n", /unexpected "\+"/],
  ];
  for (const [src, re] of bad) {
    const p = bareTextProblems(src);
    assert.equal(p.length, 1, src);
    assert.match(p[0], re);
  }
  assert.deepEqual(bareTextProblems("import { test, bareText } from '#harness/unit';\ntest('a', () => bareText('f', 'p', '&6Gold'));\n"), ['literal "&6Gold" holds an & color or format code']);
});

test('a bare literal has no placeholder, color or formatting code, or tag', () => {
  for (const ok of ['Vote Crate', 'Fish & Chips', '100% fun', 'a > b']) assert.deepEqual(literalProblems(ok), [], ok);
  const cases: [string, string][] = [['%player_name%', '%placeholder%'], ['Hi {player}', '{placeholder}'], ['<red>Hi', '<tag>'], ['&lBold', '&'], ['&#ff0000Red', '&'], ['§aGreen', '§']];
  for (const [lit, why] of cases) assert.ok(literalProblems(lit).some((p) => p.includes(why)), lit);
});
