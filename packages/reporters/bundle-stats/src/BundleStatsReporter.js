// @flow strict-local

import type {PackagedBundle} from '@parcel/types';

import {Reporter} from '@parcel/plugin';
import {DefaultMap} from '@parcel/utils';
import path from 'path';

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

function getBundleStats(bundles: Array<PackagedBundle>) {
  return {
    assets: bundles.map(bundle => {
      return {
        name: bundle.name,
        size: bundle.stats.size,
        id: bundle.id,
      };
    }),
  };
}
