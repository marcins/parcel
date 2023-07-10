const assert = require('assert');
const config = require('../index.json');
const packageJson = require('../package.json');

describe('@parcel/config-atlassian-ssr', () => {
  let /** @type {Set<string>} */ packageJsonDependencyNames;
  let /** @type {Set<string>} */ configPackageReferences;

  before(() => {
    packageJsonDependencyNames = new Set(
      Object.keys(packageJson.dependencies || {}),
    );
    configPackageReferences = collectConfigPackageReferences(config);
  });

  describe('package.json', () => {
    it('includes every package referenced in the config', () => {
      const missingReferences = [];
      for (const reference of configPackageReferences) {
        if (!packageJsonDependencyNames.has(reference)) {
          missingReferences.push(reference);
        }
      }

      // Assert with deepStrictEqual rather than e.g. missingReferences.size as the
      // assertion message with deepStrictEqual enumerates the differences nicely
      assert.deepStrictEqual(missingReferences, []);
    });

    it('does not include packages not referenced in the config', () => {
      const unnecessaryDependencies = [];
      for (const dependency of packageJsonDependencyNames) {
        if (!configPackageReferences.has(dependency)) {
          unnecessaryDependencies.push(dependency);
        }
      }

      assert.deepStrictEqual(unnecessaryDependencies, []);
    });
  });
});

/**
 * @param {any} configSection
 * @param {Set<string>} references
 * @returns {Set<string>}
 */
function collectConfigPackageReferences(configSection, references = new Set()) {
  if (configSection == null || typeof configSection !== 'object') {
    throw new TypeError('Expected config section to be an object or an array');
  }

  for (const value of Object.values(configSection)) {
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
