// @flow strict-local

import type {ContentKey} from '@parcel/graph';
import type {Async} from '@parcel/types';
import type {SharedReference} from '@parcel/workers';
import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';

import type {StaticRunOpts} from '../RequestTracker';
import type {Asset, AssetGroup, PackagedBundleInfo} from '../types';
import type BundleGraph from '../BundleGraph';

import createAssetGraphRequest from './AssetGraphRequest';
import createBundleGraphRequest from './BundleGraphRequest';
import createWriteBundlesRequest from './WriteBundlesRequest';
import {assertSignalNotAborted} from '../utils';
import dumpGraphToGraphViz from '../dumpGraphToGraphViz';
import {bundleGraphEdgeTypes} from '../BundleGraph';
import {SystemTracer} from '../Tracer';

type ParcelBuildRequestInput = {|
  optionsRef: SharedReference,
  requestedAssetIds: Set<string>,
  signal?: AbortSignal,
|};

type ParcelBuildRequestResult = {|
  bundleGraph: BundleGraph,
  bundleInfo: Map<string, PackagedBundleInfo>,
  changedAssets: Map<string, Asset>,
  assetRequests: Array<AssetGroup>,
|};

type RunInput = {|
  input: ParcelBuildRequestInput,
  ...StaticRunOpts,
|};

export type ParcelBuildRequest = {|
  id: ContentKey,
  +type: 'parcel_build_request',
  run: RunInput => Async<ParcelBuildRequestResult>,
  input: ParcelBuildRequestInput,
|};

export default function createParcelBuildRequest(
  input: ParcelBuildRequestInput,
): ParcelBuildRequest {
  return {
    type: 'parcel_build_request',
    id: 'parcel_build_request',
    run,
    input,
  };
}

async function run({input, api, options}: RunInput) {
  let {optionsRef, requestedAssetIds, signal} = input;

  const transformationMeasurement =
    SystemTracer.createMeasurement('transformation');
  let request = createAssetGraphRequest({
    name: 'Main',
    entries: options.entries,
    optionsRef,
    shouldBuildLazily: options.shouldBuildLazily,
    requestedAssetIds,
  });
  let {assetGraph, changedAssets, assetRequests, previousAssetGraphHash} =
    await api.runRequest(request, {
      force: options.shouldBuildLazily && requestedAssetIds.size > 0,
    });

  transformationMeasurement.end();

  const bundlingMeasurement = SystemTracer.createMeasurement('bundling');
  let bundleGraphRequest = createBundleGraphRequest({
    assetGraph,
    previousAssetGraphHash,
    changedAssets,
    optionsRef,
  });

  let {bundleGraph, changedAssets: changedRuntimeAssets} = await api.runRequest(
    bundleGraphRequest,
  );
  for (let [id, asset] of changedRuntimeAssets) {
    changedAssets.set(id, asset);
  }
  bundlingMeasurement.end();

  // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381 (Windows only)
  dumpGraphToGraphViz(bundleGraph._graph, 'BundleGraph', bundleGraphEdgeTypes);

  const packagingRequest = SystemTracer.createMeasurement('packaging');
  let writeBundlesRequest = createWriteBundlesRequest({
    bundleGraph,
    optionsRef,
  });

  let bundleInfo = await api.runRequest(writeBundlesRequest);
  packagingRequest.end();
  assertSignalNotAborted(signal);

  return {bundleGraph, bundleInfo, changedAssets, assetRequests};
}
