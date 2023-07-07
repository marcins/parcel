/** @typedef {import('@babel/core').PluginObj} BabelPluginObj */
/** @typedef {typeof import('@babel/types')} BabelTypes */
/** @typedef {import('@babel/types').Node} BabelNode */
/** @typedef {import('@babel/types').ObjectProperty} BabelObjectProperty */

/** @typedef {BabelObjectProperty & { key: { name: string }} & { value: { value: string }}} ObjectProperty */
/** @typedef {{ types: BabelTypes }} TransformOptions */

/**
 * @function
 * @param {TransformOptions} options
 * @returns {BabelPluginObj}
 */
function transformImportAttributesWebpack({types: t}) {
  return {
    visitor: {
      CallExpression(path) {
        const {callee, arguments: args} = path.node;
        if (callee.type !== 'Import' || args.length !== 2) {
          return;
        }

        /** @type {Array<BabelNode>} */
        const [specifierNode, attributesNode] = args;
        if (attributesNode?.type !== 'ObjectExpression') {
          return;
        }

        /** @type {Array<ObjectProperty>} */
        const newProperties = [];

        for (const property of /** @type {ObjectProperty[]} */ (
          attributesNode.properties
        )) {
          if (
            specifierNode &&
            property.key.name === 'prefetch' &&
            property.value.value
          ) {
            t.addComment(specifierNode, 'leading', ' webpackPrefetch: true ');
          } else if (
            specifierNode &&
            property.key.name === 'preload' &&
            property.value.value
          ) {
            t.addComment(specifierNode, 'leading', ' webpackPreload: true ');
          } else {
            newProperties.push(property);
          }
        }

        if (newProperties.length === 0) {
          args.pop();
        } else {
          attributesNode.properties = newProperties;
        }
      },
    },
  };
}

module.exports = transformImportAttributesWebpack;
