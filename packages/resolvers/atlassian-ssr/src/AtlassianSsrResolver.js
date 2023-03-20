// @flow

import {Resolver} from '@parcel/plugin';
import NodeResolver from '@parcel/node-resolver-core';

// Throw user friendly errors on special webpack loader syntax
// ex. `imports-loader?$=jquery!./example.js`
const WEBPACK_IMPORT_REGEX = /\S+-loader\S*!\S+/g;

export default (new Resolver({
  resolve({dependency, options, specifier}) {
    if (WEBPACK_IMPORT_REGEX.test(dependency.specifier)) {
      throw new Error(
        `The import path: ${dependency.specifier} is using webpack specific loader import syntax, which isn't supported by Parcel.`,
      );
    }

    const resolver = new NodeResolver({
      fs: options.inputFS,
      projectRoot: options.projectRoot,
      // Extensions are always required in URL dependencies.
      extensions:
        dependency.specifierType === 'commonjs' ||
        dependency.specifierType === 'esm'
          ? ['ts', 'tsx', 'js', 'jsx', 'json']
          : [],
      mainFields: ['source', 'browser', 'module', 'main'],
      // ATLASSIAN: use custom field in package.json for aliases so we can have different aliases for SSR and client builds
    });

    return resolver.resolve({
      filename: specifier,
      specifierType: dependency.specifierType,
      parent: dependency.resolveFrom,
      env: dependency.env,
      sourcePath: dependency.sourcePath,
    });
  },
}): Resolver);
