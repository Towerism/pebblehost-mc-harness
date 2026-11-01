// Loaded with --import by bin/check run. '#harness/dev' and '#harness/unit'
// always resolve to this harness's src/check/, whatever package.json the
// project or the check directory holds. A check's own files may import only
// files inside checks/<id>/ (MC_CHECK_DIR), node: built-ins and packages, so
// nothing outside the committed check tree can change what it does.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

export const IMPORT_REFUSED = 'import refused:';

const own = process.env.MC_CHECK_DIR ? pathToFileURL(`${process.env.MC_CHECK_DIR}/`).href : null;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('#harness/')) {
      const m = /^#harness\/(dev|unit)$/.exec(specifier);
      if (!m) throw new Error(`unknown harness module ${specifier}: use #harness/dev or #harness/unit`);
      return { url: pathToFileURL(`${import.meta.dirname}/${m[1]}.ts`).href, shortCircuit: true };
    }
    const r = next(specifier, context);
    if (own && context.parentURL?.startsWith(own)) {
      const bare = !/^(\.|\/|file:|#)/.test(specifier);
      if (!bare && r.url.startsWith('file:') && !r.url.startsWith(own)) throw new Error(`${IMPORT_REFUSED} ${specifier}: a check imports only files in its own directory, node: built-ins and packages`);
      if (specifier.startsWith('#')) throw new Error(`${IMPORT_REFUSED} ${specifier}: a check imports only #harness/dev and #harness/unit`);
    }
    return r;
  },
});
