// @flow

import {Resolver} from '@parcel/plugin';
import NodeResolver from '@parcel/node-resolver-core';

import invariant from 'assert';
import fs from 'fs';
import path from 'path';

// Throw user friendly errors on special webpack loader syntax
// ex. `imports-loader?$=jquery!./example.js`
const WEBPACK_IMPORT_REGEX = /\S+-loader\S*!\S+/g;
let aliasMap;
function createAliasMap(projectRoot): Map<string, string> {
  const aliasMap = new Map();
  const pkgJSON = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  Object.entries(pkgJSON['aliasSsr']).forEach(([k, v]) => {
    invariant(typeof v === 'string');
    if (k.startsWith('.')) {
      aliasMap.set(path.join(projectRoot, k), path.join(projectRoot, v));
    } else {
      aliasMap.set(k, path.join(projectRoot, v));
    }
  });
  return aliasMap;
}
export default (new Resolver({
  loadConfig({options, logger}) {
    aliasMap = aliasMap ?? createAliasMap(options.projectRoot);
    return new NodeResolver({
      fs: options.inputFS,
      projectRoot: options.projectRoot,
      // $FlowFixMe Can be removed after the `stableEntries` fetaure is gone
      packageManager: options.packageManager,
      shouldAutoInstall: options.shouldAutoInstall,
      logger,
    });
  },
  async resolve({dependency, specifier, config: resolver}) {
    if (WEBPACK_IMPORT_REGEX.test(dependency.specifier)) {
      throw new Error(
        `The import path: ${dependency.specifier} is using webpack specific loader import syntax, which isn't supported by Parcel.`,
      );
    }

    if (aliasMap.get(specifier) && !specifier.startsWith('.')) {
      return {
        filePath: aliasMap.get(specifier),
        invalidateOnFileChange: [
          path.resolve(resolver.options.projectRoot, 'package.json'),
        ],
      };
    }
    // $FlowFixMe[incompatible-call]
    let resolveResult = await resolver.resolve({
      filename: specifier,
      specifierType: dependency.specifierType,
      parent: dependency.resolveFrom,
      env: dependency.env,
      sourcePath: dependency.sourcePath,
    });

    let resolution = aliasMap.get(resolveResult?.filePath);

    if (resolution != null) {
      resolveResult.filePath = resolution;
    }

    return resolveResult;
  },
}): Resolver);
