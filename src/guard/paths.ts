// Which repo paths may be committed. classify() returns why a path is
// refused, or null when it is allowed.

export type Profile = 'public' | 'private';

export const MAX_BYTES = 512 * 1024;

// A deny rule names a directory (matched at any depth) or a basename glob.
// Matching ignores case. The first matching rule gives the reason, so
// specific globs come first.
export type Rule = { dir: string } | { base: string };

// Player data, world data, databases and archives: never committed to
// either repo. The per-plugin inventory adds its own rules to the private list.
export const PRIVATE_DENY: readonly Rule[] = [
  { dir: 'userdata' },
  { dir: 'playerdata' },
  { base: '*.mv.db' },
  { base: '*.h2.db' },
  { base: '*.db*' },
  { base: '*.sqlite*' },
  { base: '*.dat' },
  { base: '*.dat_old' },
  { base: '*.mca' },
  { base: '*.nbt' },
  { base: 'usercache.json' },
  { base: '*.zip' },
  { base: '*.tar*' },
  { base: '*.gz' },
];

// Plus server files, local state, jars and server configs. Wins over the allowlist.
export const PUBLIC_DENY: readonly Rule[] = [
  { dir: 'server' },
  { dir: 'backups' },
  { dir: '.mc' },
  { dir: '.dev' },
  { dir: 'checks' },
  { dir: 'plugins' },
  { dir: 'world*' },
  ...PRIVATE_DENY,
  { base: '*.jar*' },
  { base: 'server.properties' },
  { base: 'ops.json' },
  { base: 'whitelist.json' },
  { base: 'banned-*.json' },
];

const PUBLIC_DIRS = new Set(['bin', 'hooks', 'src', 'test', 'docker', 'templates', 'template', 'docs', '.github']);
const PUBLIC_FILES = new Set(['.claude/settings.json', 'Makefile', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.env.example']);

// Glob with * only, matched against the whole string, ignoring case.
function glob(pattern: string, s: string): boolean {
  const re = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${re}$`, 'i').test(s);
}

function denied(segments: string[], rules: readonly Rule[]): string | null {
  const dirs = segments.slice(0, -1);
  const base = segments[segments.length - 1];
  for (const rule of rules) {
    if ('dir' in rule ? dirs.some((d) => glob(rule.dir, d)) : glob(rule.base, base)) {
      return `denied: ${'dir' in rule ? `${rule.dir}/` : rule.base}`;
    }
  }
  return null;
}

export function classify(path: string, size: number, profile: Profile): string | null {
  const segments = path.split('/');
  const base = segments[segments.length - 1];
  // .env, .env.*, .envrc in any case; only the exact .env.example passes.
  if (base.toLowerCase().startsWith('.env') && base !== '.env.example') return 'denied: .env*';
  if (profile === 'private') return denied(segments, PRIVATE_DENY);
  const deny = denied(segments, PUBLIC_DENY);
  if (deny) return deny;
  const allowed = segments.length === 1 ? PUBLIC_FILES.has(path) || path.endsWith('.md') : PUBLIC_DIRS.has(segments[0]) || PUBLIC_FILES.has(path);
  if (!allowed) return 'not in the public allowlist';
  if (size > MAX_BYTES) return `${size} bytes, over the ${MAX_BYTES}-byte cap`;
  return null;
}
