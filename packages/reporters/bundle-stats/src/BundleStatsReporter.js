// @flow strict-local

import type {PackagedBundle} from '@parcel/types';

import {Reporter} from '@parcel/plugin';
import {DefaultMap} from '@parcel/utils';

import assert from 'assert';
import path from 'path';

export type AssetStat = {|
  size: number,
  name: string,
  bundles: Array<string>,
|};

export type BundleStat = {|
  size: number,
  id: string,
  assets: Array<string>,
|};

export type BundleStats = {|
  bundles: {[key: string]: BundleStat},
  assets: {[key: string]: AssetStat},
|};

export default (new Reporter({
  async report({event, options}) {
    if (event.type !== 'buildSuccess') {
      return;
    }

    let bundlesByTarget: DefaultMap<
      string /* target name */,
      Array<PackagedBundle>,
    > = new DefaultMap(() => []);
    for (let bundle of event.bundleGraph.getBundles()) {
      bundlesByTarget.get(bundle.target.name).push(bundle);
    }

    let reportsDir = path.join(options.projectRoot, 'parcel-bundle-reports');
    await options.outputFS.mkdirp(reportsDir);

    await Promise.all(
      [...bundlesByTarget.entries()].map(([targetName, bundles]) =>
        options.outputFS.writeFile(
          path.join(reportsDir, `${targetName}-stats.json`),
          JSON.stringify(getBundleStats(bundles), null, 2),
        ),
      ),
    );
  },
}): Reporter);

function getBundleStats(bundles: Array<PackagedBundle>): BundleStats {
  let bundlesByName = new Map<string, BundleStat>();
  let assetsById = new Map<string, AssetStat>();

  for (let bundle of bundles) {
    assert(!bundlesByName.has(bundle.name));

    let assets = [];
    bundle.traverseAssets(asset => {
      assets.push(asset.id);
      if (assetsById.has(asset.id)) {
        assert(assetsById.get(asset.id)?.name === asset.filePath);
        assert(assetsById.get(asset.id)?.size === asset.stats.size);
        assetsById.get(asset.id)?.bundles.push(bundle.name);
      } else {
        assetsById.set(asset.id, {
          name: asset.filePath,
          size: asset.stats.size,
          bundles: [bundle.name],
        });
      }
    });

    bundlesByName.set(bundle.name, {
      id: bundle.id,
      size: bundle.stats.size,
      assets,
    });
  }

  return {
    bundles: Object.fromEntries(bundlesByName),
    assets: Object.fromEntries(assetsById),
  };
}
