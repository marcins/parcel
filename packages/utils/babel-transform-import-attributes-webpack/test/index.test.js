const assert = require('assert');
const babel = require('@babel/core');

/** @typedef {import('@babel/core').BabelFileResult} BabelFileResult */
/** @typedef {import('@babel/core').TransformOptions} TransformOptions */

const importAttributesPlugin = require.resolve(
  '@babel/plugin-syntax-module-attributes',
);
const plugin = require.resolve('../');

describe('transformImportAttributesWebpack', () => {
  it('does not transform imports without attributes', () => {
    assert.equal(transform("import('./foo');"), "import('./foo');");
  });

  it('preserves unknown attributes', () => {
    assert.equal(
      transform(`
        import('./foo', {foobar: true});
      `),
      `import('./foo', {
  foobar: true
});`,
    );
  });

  it('transforms preload to a webpack magic comment', () => {
    assert.equal(
      transform(`
        import('./foo', {preload: true});
      `),
      `import( /* webpackPreload: true */'./foo');`,
    );
  });

  it('transforms prefetch to a webpack magic comment', () => {
    assert.equal(
      transform(`
        import('./foo', {prefetch: true});
      `),
      `import( /* webpackPrefetch: true */'./foo');`,
    );
  });

  it('preserves unknown attributes alongside magic comments', () => {
    assert.equal(
      transform(`
        import('./foo', {foobar: true, preload: true});
      `),
      `import( /* webpackPreload: true */'./foo', {
  foobar: true
});`,
    );
  });

  it('transforms both to webpack magic comments', () => {
    assert.equal(
      transform(`
        import('./foo', {prefetch: true, preload: true});
      `),
      `import(
/* webpackPreload: true */
/* webpackPrefetch: true */
'./foo');`,
    );
  });

  it('handles preload and existing comments', () => {
    assert.equal(
      transform(`
        import(/* webpackChunkName: foobar */ './foo', {preload: true});
      `),
      `import(
/* webpackPreload: true */
/* webpackChunkName: foobar */
'./foo');`,
    );
  });

  it('handles prefetch and existing comments', () => {
    assert.equal(
      transform(`
        import(/* webpackChunkName: foobar */ './foo', {prefetch: true});
      `),
      `import(
/* webpackPrefetch: true */
/* webpackChunkName: foobar */
'./foo');`,
    );
  });

  it('ignores non-boolean values in attributes', () => {
    assert.equal(
      transform(`
        import('./foo', {foobar: [], prefetch: {}});
      `),
      `import('./foo', {
  foobar: [],
  prefetch: {}
});`,
    );
  });
});

/** @returns {string | null} */
function transform(/** @type {string} */ input) {
  /** @type {TransformOptions} */
  const options = {
    configFile: false,
    plugins: [[importAttributesPlugin, {version: 'may-2020'}], plugin],
  };
  const result = babel.transformSync(input, options)?.code;
  if (!result) {
    return null;
  }
  return result;
}
