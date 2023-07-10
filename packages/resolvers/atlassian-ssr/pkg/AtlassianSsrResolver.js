const {Resolver} = require('@atlassian/parcel-plugin');
const NodeResolver = require('@atlassian/parcel-node-resolver-core');

const invariant = require('assert');
const fs = require('fs');
const path = require('path');

// Throw user friendly errors on special webpack loader syntax
// ex. `imports-loader?$=jquery!./example.js`
const WEBPACK_IMPORT_REGEX = /\S+-loader\S*!\S+/g;

/**
 *
 * @param {string} projectRoot
 * @returns {Map<string, string>}
 */
function createAliasMap(projectRoot) {
  const aliasMap = new Map();
  const pkgJSON = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  Object.entries(pkgJSON.aliasSsr).forEach(([k, v]) => {
    invariant(typeof v === 'string');
    if (k.startsWith('.')) {
      aliasMap.set(path.join(projectRoot, k), path.join(projectRoot, v));
    } else {
      aliasMap.set(k, path.join(projectRoot, v));
    }
  });
  return aliasMap;
}
const resolver = new Resolver({
  loadConfig({options, logger}) {
    return {
      resolver: new NodeResolver({
        fs: options.inputFS,
        projectRoot: options.projectRoot,
        packageManager: options.packageManager,
        shouldAutoInstall: options.shouldAutoInstall,
        logger,
      }),
      aliasMap: createAliasMap(options.projectRoot),
    };
  },
  async resolve({dependency, specifier, config}) {
    const {res, aliasMap} = config;
    if (WEBPACK_IMPORT_REGEX.test(dependency.specifier)) {
      throw new Error(
        `The import path: ${dependency.specifier} is using webpack specific loader import syntax, which isn't supported by Parcel.`,
      );
    }

    if (aliasMap.get(specifier) && !specifier.startsWith('.')) {
      return {
        filePath: aliasMap.get(specifier),
        invalidateOnFileChange: [
          path.resolve(res.options.projectRoot, 'package.json'),
        ],
      };
    }
    // $FlowFixMe[incompatible-call]
    const resolveResult = await res.resolve({
      filename: specifier,
      specifierType: dependency.specifierType,
      parent: dependency.resolveFrom,
      env: dependency.env,
      sourcePath: dependency.sourcePath,
    });

    const resolution = aliasMap.get(resolveResult?.filePath);

    if (resolution != null) {
      resolveResult.filePath = resolution;
    }

    return resolveResult;
  },
});

module.exports.default = resolver;
