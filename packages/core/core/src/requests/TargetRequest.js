// @flow strict-local

import type {Diagnostic} from '@parcel/diagnostic';
import type {FileSystem} from '@parcel/fs';
import type {
  Async,
  Engines,
  FilePath,
  PackageJSON,
  PackageTargetDescriptor,
  TargetDescriptor,
  OutputFormat,
} from '@parcel/types';
import type {StaticRunOpts, RunAPI} from '../RequestTracker';
import type {Entry, ParcelOptions, Target} from '../types';
import type {ConfigAndCachePath} from './ParcelConfigRequest';

import ThrowableDiagnostic, {
  generateJSONCodeHighlights,
  getJSONSourceLocation,
  md,
} from '@parcel/diagnostic';
import path from 'path';
import {
  loadConfig,
  resolveConfig,
  hashObject,
  validateSchema,
} from '@parcel/utils';
import {createEnvironment} from '../Environment';
import createParcelConfigRequest, {
  getCachedParcelConfig,
} from './ParcelConfigRequest';
// $FlowFixMe
import browserslist from 'browserslist';
import jsonMap from 'json-source-map';
import invariant from 'assert';
import nullthrows from 'nullthrows';
import {
  COMMON_TARGET_DESCRIPTOR_SCHEMA,
  DESCRIPTOR_SCHEMA,
  PACKAGE_DESCRIPTOR_SCHEMA,
  ENGINES_SCHEMA,
} from '../TargetDescriptor.schema';
import {BROWSER_ENVS} from '../public/Environment';
import {optionsProxy} from '../utils';

type RunOpts = {|
  input: Entry,
  ...StaticRunOpts,
|};

const DEFAULT_DIST_DIRNAME = 'dist';
const JS_RE = /\.[mc]?js$/;
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const COMMON_TARGETS = {
  main: {
    match: JS_RE,
    extensions: JS_EXTENSIONS,
  },
  module: {
    // module field is always ESM. Don't allow .cjs extension here.
    match: /\.m?js$/,
    extensions: ['.js', '.mjs'],
  },
  browser: {
    match: JS_RE,
    extensions: JS_EXTENSIONS,
  },
  types: {
    match: /\.d\.ts$/,
    extensions: ['.d.ts'],
  },
};

export type TargetRequest = {|
  id: string,
  +type: 'target_request',
  run: RunOpts => Async<Array<Target>>,
  input: Entry,
|};

const type = 'target_request';

export default function createTargetRequest(input: Entry): TargetRequest {
  return {
    id: `${type}:${hashObject(input)}`,
    type,
    run,
    input,
  };
}

export function skipTarget(
  targetName: string,
  exclusiveTarget?: FilePath,
  descriptorSource?: FilePath | Array<FilePath>,
): boolean {
  //  We skip targets if they have a descriptor.source and don't match the current exclusiveTarget
  //  They will be handled by a separate resolvePackageTargets call from their Entry point
  //  but with exclusiveTarget set.

  return exclusiveTarget == null
    ? descriptorSource != null
    : targetName !== exclusiveTarget;
}

async function run({input, api, options}: RunOpts) {
  let targetResolver = new TargetResolver(
    api,
    optionsProxy(options, api.invalidateOnOptionChange),
  );
  let targets = await targetResolver.resolve(input.packagePath, input.target);

  let configResult = nullthrows(
    await api.runRequest<null, ConfigAndCachePath>(createParcelConfigRequest()),
  );
  let parcelConfig = getCachedParcelConfig(configResult, options);

  // Find named pipelines for each target.
  let pipelineNames = new Set(parcelConfig.getNamedPipelines());
  for (let target of targets) {
    if (pipelineNames.has(target.name)) {
      target.pipeline = target.name;
    }
  }

  return targets;
}

export class TargetResolver {
  fs: FileSystem;
  api: RunAPI;
  options: ParcelOptions;

  constructor(api: RunAPI, options: ParcelOptions) {
    this.api = api;
    this.fs = options.inputFS;
    this.options = options;
  }

  async resolve(
    rootDir: FilePath,
    exclusiveTarget?: string,
  ): Promise<Array<Target>> {
    let optionTargets = this.options.targets;
    if (exclusiveTarget != null && optionTargets == null) {
      optionTargets = [exclusiveTarget];
    }

    let packageTargets = await this.resolvePackageTargets(
      rootDir,
      exclusiveTarget,
    );
    let targets: Array<Target>;
    if (optionTargets) {
      if (Array.isArray(optionTargets)) {
        if (optionTargets.length === 0) {
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: `Targets option is an empty array`,
              origin: '@parcel/core',
            },
          });
        }

        // If an array of strings is passed, it's a filter on the resolved package
        // targets. Load them, and find the matching targets.
        targets = optionTargets.map(target => {
          let matchingTarget = packageTargets.get(target);
          if (!matchingTarget) {
            throw new ThrowableDiagnostic({
              diagnostic: {
                message: md`Could not find target with name "${target}"`,
                origin: '@parcel/core',
              },
            });
          }
          return matchingTarget;
        });
      } else {
        // Otherwise, it's an object map of target descriptors (similar to those
        // in package.json). Adapt them to native targets.
        targets = Object.entries(optionTargets)
          .map(([name, _descriptor]) => {
            let {distDir, ...descriptor} = parseDescriptor(
              name,
              _descriptor,
              null,
              JSON.stringify({targets: optionTargets}, null, '\t'),
            );
            if (distDir == null) {
              let optionTargetsString = JSON.stringify(
                optionTargets,
                null,
                '\t',
              );
              throw new ThrowableDiagnostic({
                diagnostic: {
                  message: md`Missing distDir for target "${name}"`,
                  origin: '@parcel/core',
                  codeFrame: {
                    code: optionTargetsString,
                    codeHighlights: generateJSONCodeHighlights(
                      optionTargetsString || '',
                      [
                        {
                          key: `/${name}`,
                          type: 'value',
                        },
                      ],
                    ),
                  },
                },
              });
            }
            let target: Target = {
              name,
              distDir: path.resolve(this.fs.cwd(), distDir),
              publicUrl:
                descriptor.publicUrl ??
                this.options.defaultTargetOptions.publicUrl,
              env: createEnvironment({
                engines: descriptor.engines,
                context: descriptor.context,
                isLibrary: descriptor.isLibrary,
                includeNodeModules: descriptor.includeNodeModules,
                outputFormat: descriptor.outputFormat,
                shouldOptimize:
                  this.options.defaultTargetOptions.shouldOptimize &&
                  descriptor.optimize !== false,
                shouldScopeHoist:
                  this.options.defaultTargetOptions.shouldScopeHoist &&
                  descriptor.scopeHoist !== false,
                sourceMap: normalizeSourceMap(
                  this.options,
                  descriptor.sourceMap,
                ),
              }),
            };

            if (descriptor.distEntry != null) {
              target.distEntry = descriptor.distEntry;
            }

            if (descriptor.source != null) {
              target.source = descriptor.source;
            }

            return target;
          })
          .filter(
            target => !skipTarget(target.name, exclusiveTarget, target.source),
          );
      }

      let serve = this.options.serveOptions;
      if (serve) {
        // In serve mode, we only support a single browser target. If the user
        // provided more than one, or the matching target is not a browser, throw.
        if (targets.length > 1) {
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: `More than one target is not supported in serve mode`,
              origin: '@parcel/core',
            },
          });
        }
        if (!BROWSER_ENVS.has(targets[0].env.context)) {
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: `Only browser targets are supported in serve mode`,
              origin: '@parcel/core',
            },
          });
        }
        targets[0].distDir = serve.distDir;
      }
    } else {
      // Explicit targets were not provided. Either use a modern target for server
      // mode, or simply use the package.json targets.
      if (this.options.serveOptions) {
        // In serve mode, we only support a single browser target. Since the user
        // hasn't specified a target, use one targeting modern browsers for development
        targets = [
          {
            name: 'default',
            distDir: this.options.serveOptions.distDir,
            publicUrl: this.options.defaultTargetOptions.publicUrl ?? '/',
            env: createEnvironment({
              context: 'browser',
              engines: {},
              shouldOptimize: this.options.defaultTargetOptions.shouldOptimize,
              shouldScopeHoist: this.options.defaultTargetOptions
                .shouldScopeHoist,
              sourceMap: this.options.defaultTargetOptions.sourceMaps
                ? {}
                : undefined,
            }),
          },
        ];
      } else {
        targets = Array.from(packageTargets.values()).filter(descriptor => {
          return !skipTarget(
            descriptor.name,
            exclusiveTarget,
            descriptor.source,
          );
        });
      }
    }

    return targets;
  }

  async resolvePackageTargets(
    rootDir: FilePath,
    exclusiveTarget?: string,
  ): Promise<Map<string, Target>> {
    let rootFile = path.join(rootDir, 'index');
    let conf = await loadConfig(
      this.fs,
      rootFile,
      ['package.json'],
      this.options.projectRoot,
    );

    // Invalidate whenever a package.json file is added.
    this.api.invalidateOnFileCreate({
      fileName: 'package.json',
      aboveFilePath: rootFile,
    });

    let pkg;
    let pkgContents;
    let pkgFilePath: ?FilePath;
    let pkgDir: FilePath;
    let pkgMap;
    if (conf) {
      pkg = (conf.config: PackageJSON);
      let pkgFile = conf.files[0];
      if (pkgFile == null) {
        throw new ThrowableDiagnostic({
          diagnostic: {
            message: md`Expected package.json file in ${rootDir}`,
            origin: '@parcel/core',
          },
        });
      }
      let _pkgFilePath = (pkgFilePath = pkgFile.filePath); // For Flow
      pkgDir = path.dirname(_pkgFilePath);
      pkgContents = await this.fs.readFile(_pkgFilePath, 'utf8');
      pkgMap = jsonMap.parse(pkgContents.replace(/\t/g, ' '));

      this.api.invalidateOnFileUpdate(_pkgFilePath);
      this.api.invalidateOnFileDelete(_pkgFilePath);
    } else {
      pkg = {};
      pkgDir = this.fs.cwd();
    }

    let pkgTargets = pkg.targets || {};
    let pkgEngines: Engines =
      parseEngines(
        pkg.engines,
        pkgFilePath,
        pkgContents,
        '/engines',
        'Invalid engines in package.json',
      ) || {};
    if (pkgEngines.browsers == null) {
      let env =
        this.options.env.BROWSERSLIST_ENV ??
        this.options.env.NODE_ENV ??
        this.options.mode;

      if (pkg.browserslist != null) {
        let pkgBrowserslist = pkg.browserslist;
        let browserslist =
          typeof pkgBrowserslist === 'object' && !Array.isArray(pkgBrowserslist)
            ? pkgBrowserslist[env]
            : pkgBrowserslist;

        pkgEngines = {
          ...pkgEngines,
          browsers: browserslist,
        };
      } else {
        let browserslistConfig = await resolveConfig(
          this.fs,
          path.join(rootDir, 'index'),
          ['browserslist', '.browserslistrc'],
          this.options.projectRoot,
        );

        this.api.invalidateOnFileCreate({
          fileName: 'browserslist',
          aboveFilePath: rootFile,
        });

        this.api.invalidateOnFileCreate({
          fileName: '.browserslistrc',
          aboveFilePath: rootFile,
        });

        if (browserslistConfig != null) {
          let contents = await this.fs.readFile(browserslistConfig, 'utf8');
          let config = browserslist.parseConfig(contents);
          let browserslistBrowsers = config[env] || config.defaults;

          if (browserslistBrowsers?.length > 0) {
            pkgEngines = {
              ...pkgEngines,
              browsers: browserslistBrowsers,
            };
          }

          // Invalidate whenever browserslist config file or relevant environment variables change
          this.api.invalidateOnFileUpdate(browserslistConfig);
          this.api.invalidateOnFileDelete(browserslistConfig);
          this.api.invalidateOnEnvChange('BROWSERSLIST_ENV');
          this.api.invalidateOnEnvChange('NODE_ENV');
        }
      }
    }

    let targets: Map<string, Target> = new Map();
    let node = pkgEngines.node;
    let browsers = pkgEngines.browsers;

    // If there is a separate `browser` target, or an `engines.node` field but no browser targets, then
    // the `main` and `module` targets refer to node, otherwise browser.
    let mainContext =
      pkg.browser ?? pkgTargets.browser ?? (node != null && !browsers)
        ? 'node'
        : 'browser';
    let moduleContext =
      pkg.browser ?? pkgTargets.browser ? 'browser' : mainContext;

    let defaultEngines = this.options.defaultTargetOptions.engines;
    let context = browsers ?? !node ? 'browser' : 'node';
    if (
      context === 'browser' &&
      pkgEngines.browsers == null &&
      defaultEngines?.browsers != null
    ) {
      pkgEngines = {
        ...pkgEngines,
        browsers: defaultEngines.browsers,
      };
    } else if (
      context === 'node' &&
      pkgEngines.node == null &&
      defaultEngines?.node != null
    ) {
      pkgEngines = {
        ...pkgEngines,
        node: defaultEngines.node,
      };
    }

    for (let targetName in COMMON_TARGETS) {
      let _targetDist;
      let pointer;
      if (
        targetName === 'browser' &&
        pkg[targetName] != null &&
        typeof pkg[targetName] === 'object'
      ) {
        // The `browser` field can be a file path or an alias map.
        _targetDist = pkg[targetName][pkg.name];
        pointer = `/${targetName}/${pkg.name}`;
      } else {
        _targetDist = pkg[targetName];
        pointer = `/${targetName}`;
      }

      // For Flow
      let targetDist = _targetDist;
      if (typeof targetDist === 'string' || pkgTargets[targetName]) {
        let distDir;
        let distEntry;
        let loc;

        invariant(pkgMap != null);

        let _descriptor: mixed = pkgTargets[targetName] ?? {};
        if (typeof targetDist === 'string') {
          distDir = path.resolve(pkgDir, path.dirname(targetDist));
          distEntry = path.basename(targetDist);
          loc = {
            filePath: nullthrows(pkgFilePath),
            ...getJSONSourceLocation(pkgMap.pointers[pointer], 'value'),
          };
        } else {
          distDir =
            this.options.defaultTargetOptions.distDir ??
            path.join(pkgDir, DEFAULT_DIST_DIRNAME, targetName);
        }

        if (_descriptor == false) {
          continue;
        }

        let descriptor = parseCommonTargetDescriptor(
          targetName,
          _descriptor,
          pkgFilePath,
          pkgContents,
        );

        if (skipTarget(targetName, exclusiveTarget, descriptor.source)) {
          continue;
        }

        if (
          distEntry != null &&
          !COMMON_TARGETS[targetName].match.test(distEntry)
        ) {
          let contents: string =
            typeof pkgContents === 'string'
              ? pkgContents
              : // $FlowFixMe
                JSON.stringify(pkgContents, null, '\t');
          // $FlowFixMe
          let listFormat = new Intl.ListFormat('en-US', {type: 'disjunction'});
          let extensions = listFormat.format(
            COMMON_TARGETS[targetName].extensions,
          );
          let ext = path.extname(distEntry);
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: md`Unexpected output file type ${ext} in target "${targetName}"`,
              origin: '@parcel/core',
              language: 'json',
              filePath: pkgFilePath ?? undefined,
              codeFrame: {
                code: contents,
                codeHighlights: generateJSONCodeHighlights(contents, [
                  {
                    key: pointer,
                    type: 'value',
                    message: `File extension must be ${extensions}`,
                  },
                ]),
              },
              hints: [
                `The "${targetName}" field is meant for libraries. If you meant to output a ${ext} file, either remove the "${targetName}" field or choose a different target name.`,
              ],
            },
          });
        }

        if (descriptor.outputFormat === 'global') {
          let contents: string =
            typeof pkgContents === 'string'
              ? pkgContents
              : // $FlowFixMe
                JSON.stringify(pkgContents, null, '\t');
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: md`The "global" output format is not supported in the "${targetName}" target.`,
              origin: '@parcel/core',
              language: 'json',
              filePath: pkgFilePath ?? undefined,
              codeFrame: {
                code: contents,
                codeHighlights: generateJSONCodeHighlights(contents, [
                  {
                    key: `/targets/${targetName}/outputFormat`,
                    type: 'value',
                  },
                ]),
              },
              hints: [
                `The "${targetName}" field is meant for libraries. The outputFormat must be either "commonjs" or "esmodule". Either change or remove the declared outputFormat.`,
              ],
            },
          });
        }

        let inferredOutputFormat = this.inferOutputFormat(
          distEntry,
          descriptor,
          targetName,
          pkg,
          pkgFilePath,
          pkgContents,
        );

        let outputFormat =
          descriptor.outputFormat ??
          inferredOutputFormat ??
          (targetName === 'module' ? 'esmodule' : 'commonjs');
        let isModule = outputFormat === 'esmodule';

        if (
          targetName === 'main' &&
          outputFormat === 'esmodule' &&
          inferredOutputFormat !== 'esmodule'
        ) {
          let contents: string =
            typeof pkgContents === 'string'
              ? pkgContents
              : // $FlowFixMe
                JSON.stringify(pkgContents, null, '\t');
          throw new ThrowableDiagnostic({
            diagnostic: {
              // prettier-ignore
              message: md`Output format "esmodule" cannot be used in the "main" target without a .mjs extension or "type": "module" field.`,
              origin: '@parcel/core',
              language: 'json',
              filePath: pkgFilePath ?? undefined,
              codeFrame: {
                code: contents,
                codeHighlights: generateJSONCodeHighlights(contents, [
                  {
                    key: `/targets/${targetName}/outputFormat`,
                    type: 'value',
                    message: 'Declared output format defined here',
                  },
                  {
                    key: '/main',
                    type: 'value',
                    message: 'Inferred output format defined here',
                  },
                ]),
              },
              hints: [
                `Either change the output file extension to .mjs, add "type": "module" to package.json, or remove the declared outputFormat.`,
              ],
            },
          });
        }

        targets.set(targetName, {
          name: targetName,
          distDir,
          distEntry,
          publicUrl:
            descriptor.publicUrl ?? this.options.defaultTargetOptions.publicUrl,
          env: createEnvironment({
            engines: descriptor.engines ?? pkgEngines,
            context:
              descriptor.context ??
              (targetName === 'browser'
                ? 'browser'
                : isModule
                ? moduleContext
                : mainContext),
            includeNodeModules: descriptor.includeNodeModules ?? false,
            outputFormat,
            isLibrary: true,
            shouldOptimize:
              this.options.defaultTargetOptions.shouldOptimize &&
              descriptor.optimize !== false,
            shouldScopeHoist:
              this.options.defaultTargetOptions.shouldScopeHoist &&
              descriptor.scopeHoist !== false,
            sourceMap: normalizeSourceMap(this.options, descriptor.sourceMap),
          }),
          loc,
        });
      }
    }

    let customTargets = (Object.keys(pkgTargets): Array<string>).filter(
      targetName => !COMMON_TARGETS[targetName],
    );

    // Custom targets
    for (let targetName of customTargets) {
      let distPath: mixed = pkg[targetName];
      let distDir;
      let distEntry;
      let loc;
      if (distPath == null) {
        distDir =
          this.options.defaultTargetOptions.distDir ??
          path.join(pkgDir, DEFAULT_DIST_DIRNAME);
        if (customTargets.length >= 2) {
          distDir = path.join(distDir, targetName);
        }
      } else {
        if (typeof distPath !== 'string') {
          let contents: string =
            typeof pkgContents === 'string'
              ? pkgContents
              : // $FlowFixMe
                JSON.stringify(pkgContents, null, '\t');
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: md`Invalid distPath for target "${targetName}"`,
              origin: '@parcel/core',
              language: 'json',
              filePath: pkgFilePath ?? undefined,
              codeFrame: {
                code: contents,
                codeHighlights: generateJSONCodeHighlights(contents, [
                  {
                    key: `/${targetName}`,
                    type: 'value',
                    message: 'Expected type string',
                  },
                ]),
              },
            },
          });
        }
        distDir = path.resolve(pkgDir, path.dirname(distPath));
        distEntry = path.basename(distPath);

        invariant(typeof pkgFilePath === 'string');
        invariant(pkgMap != null);
        loc = {
          filePath: pkgFilePath,
          ...getJSONSourceLocation(pkgMap.pointers[`/${targetName}`], 'value'),
        };
      }

      if (targetName in pkgTargets) {
        let descriptor = parsePackageDescriptor(
          targetName,
          pkgTargets[targetName],
          pkgFilePath,
          pkgContents,
        );
        let pkgDir = path.dirname(nullthrows(pkgFilePath));
        if (skipTarget(targetName, exclusiveTarget, descriptor.source)) {
          continue;
        }

        let inferredOutputFormat = this.inferOutputFormat(
          distEntry,
          descriptor,
          targetName,
          pkg,
          pkgFilePath,
          pkgContents,
        );

        targets.set(targetName, {
          name: targetName,
          distDir:
            descriptor.distDir != null
              ? path.resolve(pkgDir, descriptor.distDir)
              : distDir,
          distEntry,
          publicUrl:
            descriptor.publicUrl ?? this.options.defaultTargetOptions.publicUrl,
          // ATLASSIAN: "stableEntries": false causes entries with hashes
          // TODO: Make this env var invalidate cache entries
          stableEntries:
            typeof process.env.PARCEL_STABLE_ENTRIES === 'string' ||
            descriptor.stableEntries,
          env: createEnvironment({
            engines: descriptor.engines ?? pkgEngines,
            context: descriptor.context,
            includeNodeModules: descriptor.includeNodeModules,
            outputFormat:
              descriptor.outputFormat ?? inferredOutputFormat ?? undefined,
            isLibrary: descriptor.isLibrary,
            shouldOptimize:
              this.options.defaultTargetOptions.shouldOptimize &&
              descriptor.optimize !== false,
            shouldScopeHoist:
              this.options.defaultTargetOptions.shouldScopeHoist &&
              descriptor.scopeHoist !== false,
            sourceMap: normalizeSourceMap(this.options, descriptor.sourceMap),
          }),
          loc,
        });
      }
    }

    // If no explicit targets were defined, add a default.
    if (targets.size === 0) {
      targets.set('default', {
        name: 'default',
        distDir:
          this.options.defaultTargetOptions.distDir ??
          path.join(pkgDir, DEFAULT_DIST_DIRNAME),
        publicUrl: this.options.defaultTargetOptions.publicUrl,
        env: createEnvironment({
          engines: pkgEngines,
          context,
          shouldOptimize: this.options.defaultTargetOptions.shouldOptimize,
          shouldScopeHoist: this.options.defaultTargetOptions.shouldScopeHoist,
          sourceMap: this.options.defaultTargetOptions.sourceMaps
            ? {}
            : undefined,
        }),
      });
    }

    assertNoDuplicateTargets(targets, pkgFilePath, pkgContents);

    return targets;
  }

  inferOutputFormat(
    distEntry: ?FilePath,
    descriptor: PackageTargetDescriptor,
    targetName: string,
    pkg: PackageJSON,
    pkgFilePath: ?FilePath,
    pkgContents: ?string,
  ): ?OutputFormat {
    // Infer the outputFormat based on package.json properties.
    // If the extension is .mjs it's always a module.
    // If the extension is .cjs, it's always commonjs.
    // If the "type" field is set to "module" and the extension is .js, it's a module.
    let ext = distEntry != null ? path.extname(distEntry) : null;
    let inferredOutputFormat, inferredOutputFormatField;
    switch (ext) {
      case '.mjs':
        inferredOutputFormat = 'esmodule';
        inferredOutputFormatField = `/${targetName}`;
        break;
      case '.cjs':
        inferredOutputFormat = 'commonjs';
        inferredOutputFormatField = `/${targetName}`;
        break;
      case '.js':
        if (pkg.type === 'module') {
          inferredOutputFormat = 'esmodule';
          inferredOutputFormatField = '/type';
        }
        break;
    }

    if (
      descriptor.outputFormat &&
      inferredOutputFormat &&
      descriptor.outputFormat !== inferredOutputFormat
    ) {
      let contents: string =
        typeof pkgContents === 'string'
          ? pkgContents
          : // $FlowFixMe
            JSON.stringify(pkgContents, null, '\t');
      let expectedExtensions;
      switch (descriptor.outputFormat) {
        case 'esmodule':
          expectedExtensions = ['.mjs', '.js'];
          break;
        case 'commonjs':
          expectedExtensions = ['.cjs', '.js'];
          break;
        case 'global':
          expectedExtensions = ['.js'];
          break;
      }
      // $FlowFixMe
      let listFormat = new Intl.ListFormat('en-US', {type: 'disjunction'});
      throw new ThrowableDiagnostic({
        diagnostic: {
          message: md`Declared output format "${descriptor.outputFormat}" does not match expected output format "${inferredOutputFormat}".`,
          origin: '@parcel/core',
          language: 'json',
          filePath: pkgFilePath ?? undefined,
          codeFrame: {
            code: contents,
            codeHighlights: generateJSONCodeHighlights(contents, [
              {
                key: `/targets/${targetName}/outputFormat`,
                type: 'value',
                message: 'Declared output format defined here',
              },
              {
                key: nullthrows(inferredOutputFormatField),
                type: 'value',
                message: 'Inferred output format defined here',
              },
            ]),
          },
          hints: [
            inferredOutputFormatField === '/type'
              ? 'Either remove the target\'s declared "outputFormat" or remove the "type" field.'
              : `Either remove the target's declared "outputFormat" or change the extension to ${listFormat.format(
                  expectedExtensions,
                )}.`,
          ],
        },
      });
    }

    return inferredOutputFormat;
  }
}

function parseEngines(
  engines: mixed,
  pkgPath: ?FilePath,
  pkgContents: ?string,
  prependKey: string,
  message: string,
): Engines | typeof undefined {
  if (engines === undefined) {
    return engines;
  } else {
    validateSchema.diagnostic(
      ENGINES_SCHEMA,
      {data: engines, source: pkgContents, filePath: pkgPath, prependKey},
      '@parcel/core',
      message,
    );
    // $FlowFixMe we just verified this
    return engines;
  }
}

function parseDescriptor(
  targetName: string,
  descriptor: mixed,
  pkgPath: ?FilePath,
  pkgContents: ?string,
): TargetDescriptor {
  validateSchema.diagnostic(
    DESCRIPTOR_SCHEMA,
    {
      data: descriptor,
      source: pkgContents,
      filePath: pkgPath,
      prependKey: `/targets/${targetName}`,
    },
    '@parcel/core',
    `Invalid target descriptor for target "${targetName}"`,
  );

  // $FlowFixMe we just verified this
  return descriptor;
}

function parsePackageDescriptor(
  targetName: string,
  descriptor: mixed,
  pkgPath: ?FilePath,
  pkgContents: ?string,
): PackageTargetDescriptor {
  validateSchema.diagnostic(
    PACKAGE_DESCRIPTOR_SCHEMA,
    {
      data: descriptor,
      source: pkgContents,
      filePath: pkgPath,
      prependKey: `/targets/${targetName}`,
    },
    '@parcel/core',
    `Invalid target descriptor for target "${targetName}"`,
  );
  // $FlowFixMe we just verified this
  return descriptor;
}

function parseCommonTargetDescriptor(
  targetName: string,
  descriptor: mixed,
  pkgPath: ?FilePath,
  pkgContents: ?string,
): PackageTargetDescriptor {
  validateSchema.diagnostic(
    COMMON_TARGET_DESCRIPTOR_SCHEMA,
    {
      data: descriptor,
      source: pkgContents,
      filePath: pkgPath,
      prependKey: `/targets/${targetName}`,
    },
    '@parcel/core',
    `Invalid target descriptor for target "${targetName}"`,
  );

  // $FlowFixMe we just verified this
  return descriptor;
}

function assertNoDuplicateTargets(targets, pkgFilePath, pkgContents) {
  // Detect duplicate targets by destination path and provide a nice error.
  // Without this, an assertion is thrown much later after naming the bundles and finding duplicates.
  let targetsByPath: Map<string, Array<string>> = new Map();
  for (let target of targets.values()) {
    if (target.distEntry != null) {
      let distPath = path.join(target.distDir, target.distEntry);
      if (!targetsByPath.has(distPath)) {
        targetsByPath.set(distPath, []);
      }
      targetsByPath.get(distPath)?.push(target.name);
    }
  }

  let diagnostics: Array<Diagnostic> = [];
  for (let [targetPath, targetNames] of targetsByPath) {
    if (targetNames.length > 1 && pkgContents != null && pkgFilePath != null) {
      diagnostics.push({
        message: md`Multiple targets have the same destination path "${path.relative(
          path.dirname(pkgFilePath),
          targetPath,
        )}"`,
        origin: '@parcel/core',
        language: 'json',
        filePath: pkgFilePath || undefined,
        codeFrame: {
          code: pkgContents,
          codeHighlights: generateJSONCodeHighlights(
            pkgContents,
            targetNames.map(t => ({
              key: `/${t}`,
              type: 'value',
            })),
          ),
        },
      });
    }
  }

  if (diagnostics.length > 0) {
    // Only add hints to the last diagnostic so it isn't duplicated on each one
    diagnostics[diagnostics.length - 1].hints = [
      'Try removing the duplicate targets, or changing the destination paths.',
    ];

    throw new ThrowableDiagnostic({
      diagnostic: diagnostics,
    });
  }
}

function normalizeSourceMap(options: ParcelOptions, sourceMap) {
  if (options.defaultTargetOptions.sourceMaps) {
    if (typeof sourceMap === 'boolean') {
      return sourceMap ? {} : undefined;
    } else {
      return sourceMap ?? {};
    }
  } else {
    return undefined;
  }
}
