// Loaded with --import by bin/check run: '#harness/dev' and '#harness/unit'
// always resolve to this harness's src/check/, whatever package.json the
// project or the check directory holds, so no check can swap in its own API.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('#harness/')) return next(specifier, context);
    const m = /^#harness\/(dev|unit)$/.exec(specifier);
    if (!m) throw new Error(`unknown harness module ${specifier}: use #harness/dev or #harness/unit`);
    return { url: pathToFileURL(`${import.meta.dirname}/${m[1]}.ts`).href, shortCircuit: true };
  },
});
