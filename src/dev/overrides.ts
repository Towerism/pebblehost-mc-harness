// Dev-only config changes baked into the image's last layer, so the server
// boots offline without phoning home. Each override sets one key of one file
// under the server tree (.properties by key, YAML by dotted path); a missing
// file or key is a no-op with a note, never an error.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Override = { file: string; key: string; value: string; why: string };
export type Applied = { file: string; content: string | null; notes: string[]; set: number };

const UPDATE = 'update check: no network in the pod';
const METRICS = 'metrics: no network in the pod';

// Keys as they appear in the live copy's configs (2026-11-01).
export const OVERRIDES: readonly Override[] = [
  { file: 'server.properties', key: 'online-mode', value: 'false', why: 'no Mojang session servers offline' },
  { file: 'config/paper-global.yml', key: 'update-checker.enabled', value: 'false', why: UPDATE },
  { file: 'plugins/bStats/config.yml', key: 'enabled', value: 'false', why: METRICS },
  { file: 'plugins/Votifier/config.yml', key: 'port', value: '-1', why: 'vote listener off: a negative port disables it' },
  { file: 'plugins/Minepacks/config.yml', key: 'Misc.AutoUpdate.Enabled', value: 'false', why: UPDATE },
  { file: 'plugins/ViaVersion/config.yml', key: 'check-for-updates', value: 'false', why: UPDATE },
  { file: 'plugins/GrimAC/config.yml', key: 'check-for-updates', value: 'false', why: UPDATE },
  { file: 'plugins/AuraSkills/config.yml', key: 'check_for_updates', value: 'false', why: UPDATE },
  { file: 'plugins/ODailyQuests/config.yml', key: 'check_for_update', value: 'false', why: UPDATE },
  { file: 'plugins/FurnitureLib/config.yml', key: 'general-options.checkForUpdate', value: 'false', why: UPDATE },
  { file: 'plugins/FurnitureLib/config.yml', key: 'general-options.useMetrics', value: 'false', why: METRICS },
  { file: 'plugins/BestTools/config.yml', key: 'check-for-updates', value: 'false', why: UPDATE },
  { file: 'plugins/UltraCosmetics/config.yml', key: 'Check-For-Updates', value: 'false', why: UPDATE },
  { file: 'plugins/CombatLogX/config.yml', key: 'update-checker', value: 'false', why: UPDATE },
  { file: 'plugins/KoTH/config.yml', key: 'update-checker', value: 'false', why: UPDATE },
  { file: 'plugins/Lottery/config.yml', key: 'UpdateCheck', value: 'false', why: UPDATE },
  { file: 'plugins/Lottery/config.yml', key: 'Metrics', value: 'false', why: METRICS },
  { file: 'plugins/sleep-most/config.yml', key: 'update-checker-enabled', value: 'false', why: UPDATE },
  { file: 'plugins/PlayerAuctions/config.yml', key: 'settings.notify-update', value: 'false', why: UPDATE },
  { file: 'plugins/PlayerAuctions/config.yml', key: 'settings.metrics', value: 'false', why: METRICS },
  { file: 'plugins/PlayerWarps/config.yml', key: 'settings.notify-update', value: 'false', why: UPDATE },
  { file: 'plugins/PlayerWarps/config.yml', key: 'settings.metrics', value: 'false', why: METRICS },
  { file: 'plugins/CrazyVouchers/config.yml', key: 'root.toggle-metrics', value: 'false', why: METRICS },
  { file: 'plugins/DeluxeMenus/config.yml', key: 'check_updates', value: 'false', why: UPDATE },
  { file: 'plugins/EasyCommandBlocker/config.yml', key: 'update_notify', value: 'false', why: UPDATE },
  { file: 'plugins/InteractionVisualizer/config.yml', key: 'Options.Updater', value: 'false', why: UPDATE },
];

// Set key=value in a .properties text, keeping every other line as is.
export function setProperty(text: string, key: string, value: string): string | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.slice(0, l.indexOf('=')).trim() === key && !l.trimStart().startsWith('#'));
  if (i < 0) return null;
  lines[i] = `${key}=${value}`;
  return lines.join('\n');
}

const indent = (l: string) => l.length - l.trimStart().length;
const content = (l: string) => l.trim() !== '' && !l.trimStart().startsWith('#');

// Set a block-style YAML key by dotted path, editing only that line (any
// inline comment is dropped). Returns null when the path isn't there.
export function setYaml(text: string, path: string, value: string): string | null {
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  const segs = path.split('.');
  for (let s = 0; s < segs.length; s++) {
    const first = lines.slice(start, end).findIndex(content);
    if (first < 0) return null;
    const level = indent(lines[start + first]);
    const re = new RegExp(`^(\\s*)(["']?)${segs[s].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2\\s*:(\\s|$)`);
    let at = -1;
    for (let i = start; i < end; i++) {
      if (content(lines[i]) && indent(lines[i]) === level && re.test(lines[i])) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    if (s === segs.length - 1) {
      lines[at] = `${lines[at].slice(0, lines[at].indexOf(':') + 1)} ${value}`;
      return lines.join('\n');
    }
    start = at + 1;
    end = start;
    while (end < lines.length && (!content(lines[end]) || indent(lines[end]) > level)) end++;
  }
  return null;
}

// The rewritten files for `cfg` (the server tree minus jars), one per file,
// with every override for it applied in order.
export function applyOverrides(cfg: string, list: readonly Override[] = OVERRIDES): Applied[] {
  const files = new Map<string, Applied>();
  for (const o of list) {
    let a = files.get(o.file);
    if (!a) {
      const path = join(cfg, o.file);
      a = { file: o.file, content: existsSync(path) ? readFileSync(path, 'utf8') : null, notes: [], set: 0 };
      files.set(o.file, a);
    }
    if (a.content === null) {
      a.notes.push(`${o.file} absent: ${o.key} not set`);
      continue;
    }
    const next = o.file.endsWith('.properties') ? setProperty(a.content, o.key, o.value) : setYaml(a.content, o.key, o.value);
    if (next === null) {
      a.notes.push(`${o.file}: no ${o.key} key, left as is`);
      continue;
    }
    a.content = next;
    a.set++;
    a.notes.push(`${o.file}: ${o.key}=${o.value} (${o.why})`);
  }
  return [...files.values()];
}
