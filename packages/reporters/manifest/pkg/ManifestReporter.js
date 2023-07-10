/** @typedef {import('@parcel/types').PackagedBundle} PackagedBundle */
/** @typedef {import('@parcel/types').Target} Target */

const path = require('path');
const {Reporter} = require('@parcel/plugin');

const reporter = new Reporter({
  async report({event, options}) {
    if (event.type !== 'buildSuccess' || options.mode !== 'production') {
      return;
    }

    const {bundleGraph} = event;
    /** @type {Map<string, {target: Target, entryBundles: Set<PackagedBundle>}>} */
    const entryBundlesByTarget = new Map();

    bundleGraph.traverseBundles((bundle, _, actions) => {
      let res = entryBundlesByTarget.get(bundle.target.name);
      if (res == null) {
        res = {
          target: bundle.target,
          entryBundles: new Set(),
        };
        entryBundlesByTarget.set(bundle.target.name, res);
      }
      res.entryBundles.add(bundle);
      actions.skipChildren();
    });

    await Promise.all(
      Array.from(entryBundlesByTarget).map(
        async ([, {target, entryBundles}]) => {
          const manifest = {};
          for (const entryBundle of entryBundles) {
            const mainEntry = entryBundle.getMainEntry();
            if (mainEntry != null) {
              manifest[path.basename(mainEntry.filePath)] = bundleGraph
                .getReferencedBundles(entryBundle)
                .concat([entryBundle])
                .map(b => path.basename(b.filePath));
            }
          }

          await options.outputFS.writeFile(
            path.join(target.distDir, 'parcel-manifest.json'),
            JSON.stringify(manifest, null, 2),
          );
        },
      ),
    );
  },
});

module.exports.default = reporter;
