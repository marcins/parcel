// @flow

import {Resolver} from '@parcel/plugin';
import NodeResolver from '@parcel/node-resolver-core';

// Throw user friendly errors on special webpack loader syntax
// ex. `imports-loader?$=jquery!./example.js`
const WEBPACK_IMPORT_REGEX = /^\w+-loader(?:\?\S*)?!/;

export default (new Resolver({
  loadConfig({options, logger}) {
    return new NodeResolver({
      fs: options.inputFS,
      projectRoot: options.projectRoot,
      // $FlowFixMe Can be removed after the `stableEntries` fetaure is gone
      packageManager: options.packageManager,
      shouldAutoInstall: options.shouldAutoInstall,
      logger,
    });
  },
  resolve({dependency, specifier, config: resolver}) {
    if (WEBPACK_IMPORT_REGEX.test(dependency.specifier)) {
      throw new Error(
        `The import path: ${dependency.specifier} is using webpack specific loader import syntax, which isn't supported by Parcel.`,
      );
    }

    return resolver.resolve({
      filename: specifier,
      specifierType: dependency.specifierType,
      range: dependency.range,
      parent: dependency.resolveFrom,
      env: dependency.env,
      sourcePath: dependency.sourcePath,
      loc: dependency.loc,
      packageConditions: dependency.packageConditions,
    });
  },
}): Resolver);
