const path = require('path');
const {Reporter} = require('@parcel/plugin');

/**
 * @template {import('@parcel/types').Bundle} T
 * @typedef {import('@parcel/types').BundleGraph<T>} BundleGraph<T>
 */

/** @typedef {import('@parcel/types').PackagedBundle} PackagedBundle */
/** @typedef {import('@parcel/types').Dependency} Dependency */
/** @typedef {import('@parcel/types').Target} Target */
/** @typedef {{ id: string, name: string, file: string, publicPath: string }} Manifest */

/** @type {Record<string, Array<Manifest>>} */
const manifest = {};

/** @returns {Record<string, Array<Manifest>>} */
const buildManifest = (
  /** @type {Set<PackagedBundle>} */ bundles,
  /** @type {BundleGraph<PackagedBundle>} */ bundleGraph,
) => {
  /** @type {Record<string, Set<PackagedBundle>>} */
  const assets = {};

  for (const bundle of bundles) {
    if (bundle.type !== 'js') {
      continue;
    }

    /** @type {Dependency[]} */
    const asyncDependencies = [];

    bundle.traverse(node => {
      if (node.type === 'dependency') {
        asyncDependencies.push(node.value);
      }
    });

    if (asyncDependencies.length < 1) {
      continue;
    }

    for (const dependency of asyncDependencies) {
      const resolved = bundleGraph.resolveAsyncDependency(dependency, bundle);
      if (resolved == null || resolved.type === 'asset') {
        continue;
      }

      const allBundles = bundleGraph.getBundlesInBundleGroup(resolved.value);

      /** @type {PackagedBundle | undefined} */
      const entryBundle = allBundles.find(
        bundle => bundle.getMainEntry()?.id === resolved.value.entryAssetId,
      );

      if (entryBundle === undefined) {
        throw new Error('No entry bundle');
      }

      const asset = assets[dependency.specifier] || new Set();
      asset.add(entryBundle);
      assets[dependency.specifier] = asset;
    }
  }

  // convert set to array of obj with bundle name as file
  for (const key of Object.keys(assets)) {
    const packageBundles = assets[key];
    if (!packageBundles) {
      continue;
    }

    for (const bundle of packageBundles) {
      const {filePath, id} = bundle;

      if (!manifest[key]) {
        manifest[key] = [];
      }

      const fileName = path.basename(filePath);

      manifest[key]?.push({
        id: id,
        name: fileName,
        file: fileName,
        publicPath: fileName,
      });
    }
  }

  return manifest;
};

const reporter = new Reporter({
  async report({event, options}) {
    if (
      process.env['NODE_ENV'] !== 'test' &&
      options.mode == 'development' &&
      process.env['PARCEL_REACT_LOADABLE'] == null
    ) {
      return;
    }
    if (event.type !== 'buildSuccess') {
      return;
    }

    const bundleGraph = event.bundleGraph;

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
    }, undefined);

    await Promise.all(
      Array.from(entryBundlesByTarget).map(
        async ([, {target, entryBundles}]) => {
          const manifest = buildManifest(entryBundles, bundleGraph);
          await options.outputFS.writeFile(
            path.join(target.distDir, 'react-loadable.json'),
            JSON.stringify(manifest, null, 2),
            undefined,
          );
        },
      ),
    );
  },
});

exports.default = reporter;
