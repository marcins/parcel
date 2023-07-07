const assert = require('assert');
const config = require('../index.json');

/** @type {typeof import('../package.json') & { parcelDependencies?: Record<string, any> }} */
const packageJson = require('../package.json');

describe('@parcel/config-atlassian', () => {
  /** @type {Set<string>} */
  let packageJsonDependencyNames;

  /** @type {Set<string>} */
  let configPackageReferences;

  before(() => {
    packageJsonDependencyNames = new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.parcelDependencies || {}),
    ]);
    configPackageReferences = collectConfigPackageReferences(config);
  });

  describe('package.json', () => {
    it('includes every package referenced in the config', () => {
      let missingReferences = [];
      for (let reference of configPackageReferences) {
        if (!packageJsonDependencyNames.has(reference)) {
          missingReferences.push(reference);
        }
      }

      // Assert with deepStrictEqual rather than e.g. missingReferences.size as the
      // assertion message with deepEqual enumerates the differences nicely
      assert.deepStrictEqual(missingReferences, []);
    });

    it('does not include packages not referenced in the config', () => {
      let unnecessaryDependencies = [];
      for (let dependency of packageJsonDependencyNames) {
        if (!configPackageReferences.has(dependency)) {
          unnecessaryDependencies.push(dependency);
        }
      }

      assert.deepStrictEqual(unnecessaryDependencies, []);
    });
  });
});

/** @returns {Set<string>} */
function collectConfigPackageReferences(
  /** @type {any} */ configSection,
  /** @type {Set<string>} */ references = new Set(),
) {
  if (configSection == null || typeof configSection !== 'object') {
    throw new TypeError('Expected config section to be an object or an array');
  }

  for (let value of Object.values(configSection)) {
    if (typeof value === 'string') {
      if (value === '...') {
        continue;
      }

      references.add(value);
    } else if (configSection != null && typeof configSection === 'object') {
      collectConfigPackageReferences(value, references);
    } else {
      throw new Error(
        'Parcel configs must contain only strings, arrays, or objects in value positions',
      );
    }
  }

  return references;
}
