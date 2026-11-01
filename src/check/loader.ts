// Loaded with --import by bin/check run. '#harness/dev', '#harness/bot' and '#harness/unit'
// always resolve to this harness's src/check/, whatever package.json the
// project or the check directory holds. A check's own files may import only
// files inside checks/<id>/ (MC_CHECK_DIR), node: built-ins and packages, and
// no module anywhere may load a data:, http: or other non-file URL. This is
// hygiene against helpers that change between red and green, not a sandbox:
// a check can still read files or spawn processes; reviewers read the check.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

export const IMPORT_REFUSED = 'import refused:';

const own = process.env.MC_CHECK_DIR ? pathToFileURL(`${process.env.MC_CHECK_DIR}/`).href : null;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('#harness/')) {
      const m = /^#harness\/(dev|unit|bot)$/.exec(specifier);
      if (!m) throw new Error(`unknown harness module ${specifier}: use #harness/dev, #harness/bot or #harness/unit`);
      return { url: pathToFileURL(`${import.meta.dirname}/${m[1]}.ts`).href, shortCircuit: true };
    }
    // data:, http: and other schemes load code from nowhere in the check tree
    // (a data: module can import any file:, being outside the check itself).
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(specifier)?.[1].toLowerCase();
    if (scheme !== undefined && scheme !== 'node' && scheme !== 'file') throw new Error(`${IMPORT_REFUSED} ${specifier.slice(0, 60)}: a check imports only files in its own directory, node: built-ins and packages`);
    const r = next(specifier, context);
    if (own && context.parentURL?.startsWith(own)) {
      const bare = !/^(\.|\/|file:|#)/.test(specifier);
      if (!bare && r.url.startsWith('file:') && !r.url.startsWith(own)) throw new Error(`${IMPORT_REFUSED} ${specifier}: a check imports only files in its own directory, node: built-ins and packages`);
      if (specifier.startsWith('#')) throw new Error(`${IMPORT_REFUSED} ${specifier}: a check imports only #harness/dev, #harness/bot and #harness/unit`);
    }
    return r;
  },
});
