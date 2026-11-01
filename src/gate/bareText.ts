// G8: a bare-text check may hold only
//   import { test, bareText } from '#harness/unit';
//   test('name', () => bareText('file', 'path', 'literal'));
// (or a block of bareText calls), and each literal must be bare: no
// placeholder, color or formatting code, or MiniMessage tag. Returns the
// problems found; none means the file passes.

type Tok = { kind: 'str' | 'id' | 'punct'; value: string; at: string };

function tokenize(src: string): Tok[] | string {
  const toks: Tok[] = [];
  let line = 1;
  let col = 1;
  for (let i = 0; i < src.length; ) {
    const rest = src.slice(i);
    const at = `${line}:${col}`;
    const m = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest) ?? /^("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/.exec(rest) ?? /^([A-Za-z_$][\w$]*|=>|[(){},;])/.exec(rest);
    if (!m) return `unexpected ${JSON.stringify(src[i])} at ${at}`;
    const t = m[1];
    if (/^["']/.test(t)) {
      const body = t.slice(1, -1);
      try {
        toks.push({ kind: 'str', value: JSON.parse(`"${t[0] === "'" ? body.replace(/\\'/g, "'").replace(/"/g, '\\"') : body}"`), at });
      } catch {
        return `bad string at ${at}`;
      }
    } else if (!/^\s|^\//.test(t)) toks.push({ kind: /^[\w$]/.test(t) ? 'id' : 'punct', value: t, at });
    for (const ch of t) {
      if (ch === '\n') {
        line++;
        col = 1;
      } else col++;
    }
    i += t.length;
  }
  return toks;
}

// What a bare literal must not hold, with the reason shown.
const NOT_BARE: [RegExp, string][] = [
  [/%[^%\s]+%/, 'a %placeholder%'],
  [/\{[^}]*\}/, 'a {placeholder}'],
  [/<[^>]*>/, 'a <tag>'],
  [/&(#[0-9a-f]{6}|[0-9a-fk-orx])/i, 'an & color or format code'],
  [/§/, 'a § code'],
];

export function literalProblems(literal: string): string[] {
  return NOT_BARE.filter(([re]) => re.test(literal)).map(([, why]) => `literal ${JSON.stringify(literal)} holds ${why}`);
}

export function bareTextProblems(src: string): string[] {
  return parseBareText(src).problems;
}

// The problems, and the server files the bareText() calls read (G4 needs the
// fix to touch each of them).
export function parseBareText(src: string): { problems: string[]; files: string[] } {
  const toks = tokenize(src);
  if (typeof toks === 'string') return { problems: [`not a bare-text check: ${toks}`], files: [] };
  let i = 0;
  const problems: string[] = [];
  const files: string[] = [];
  const peek = () => toks[i];
  const expect = (value: string | null, kind: Tok['kind'] = 'punct'): Tok => {
    const t = toks[i];
    if (!t || t.kind !== kind || (value !== null && t.value !== value)) throw new Error(`expected ${value ?? kind} at ${t?.at ?? 'end'}, found ${t ? JSON.stringify(t.value) : 'nothing'}`);
    i++;
    return t;
  };
  const semi = () => {
    if (peek()?.value === ';') i++;
  };
  const call = () => {
    expect('bareText', 'id');
    expect('(');
    const args = [expect(null, 'str'), (expect(','), expect(null, 'str')), (expect(','), expect(null, 'str'))];
    expect(')');
    files.push(args[0].value);
    problems.push(...literalProblems(args[2].value));
  };
  try {
    expect('import', 'id');
    expect('{');
    do {
      const name = expect(null, 'id');
      if (name.value !== 'test' && name.value !== 'bareText') throw new Error(`only test and bareText may be imported, not ${name.value} (${name.at})`);
      if (peek()?.value !== ',') break;
      i++;
    } while (peek()?.value !== '}');
    expect('}');
    expect('from', 'id');
    const from = expect(null, 'str');
    if (from.value !== '#harness/unit') throw new Error(`imports only from '#harness/unit', not '${from.value}' (${from.at})`);
    semi();
    let tests = 0;
    while (i < toks.length) {
      expect('test', 'id');
      expect('(');
      expect(null, 'str');
      expect(',');
      expect('(');
      expect(')');
      expect('=>');
      if (peek()?.value === '{') {
        i++;
        do {
          call();
          semi();
        } while (peek()?.value !== '}');
        expect('}');
      } else call();
      expect(')');
      semi();
      tests++;
    }
    if (tests === 0) throw new Error('no test(...)');
  } catch (e) {
    return { problems: [`not a bare-text check: ${(e as Error).message}`], files };
  }
  return { problems, files: [...new Set(files)] };
}
