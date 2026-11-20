/**
 * Minimal type restatements for the client Remote mount surface. The real
 * types live in `@deepseek-ai/dsh-typert-protocol` / the api-gateway client,
 * which are not published to npm; only the shapes this bundle constructs are
 * declared here.
 */

export interface TypertRemoteContribution {
  readonly package: string
  readonly descriptors: readonly InvocationDescriptor[]
}

export interface InvocationDescriptor {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly invocation: { readonly kind: 'direct' }
  readonly parameters: readonly InvocationParameter[]
  readonly cancellation?: { readonly parameter: 'signal' } | undefined
  readonly result: TypertCodec
}

export interface InvocationParameter {
  readonly name: string
  readonly wire: string
  readonly source: 'json'
  readonly codec: TypertCodec
}

export interface TypertCodec {
  readonly mode: 'strict' | 'src-json'
  readonly typeSymbol?: string | undefined
  readonly create?: (() => { parse(value: unknown): unknown }) | undefined
  readonly decode?: ((value: unknown) => unknown) | undefined
}

export interface RemoteResultOk<T> {
  readonly ok: true
  readonly value: T
}

export interface RemoteResultFail {
  readonly ok: false
  readonly error: { code?: string | undefined; message?: string | undefined } & Record<string, unknown>
}

export type RemoteResult<T> = RemoteResultOk<T> | RemoteResultFail

/** Positional namespace call face installed by `$mount` descriptors. */
export interface RemoteNamespace {
  [method: string]: (...args: never[]) => Promise<RemoteResult<unknown>>
}

export interface ClientRemoteFace {
  $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
  compactTool: CompactToolCalls
}

import type {
  CatalogResult,
  CompactConfig,
  DescribeResult,
  EffectiveResult,
  ModelInfoResult,
  PolicyPatch,
} from '../shared.js'

/** Typed view of the `compactTool` namespace methods. */
export interface CompactToolCalls {
  describe(): Promise<RemoteResult<DescribeResult>>
  catalog(): Promise<RemoteResult<CatalogResult>>
  modelInfo(provider: string, model: string): Promise<RemoteResult<ModelInfoResult>>
  effectiveFor(provider: string, model: string): Promise<RemoteResult<EffectiveResult>>
  patchGlobal(patch: PolicyPatch): Promise<RemoteResult<CompactConfig>>
  setModelPolicy(provider: string, model: string, fields: PolicyPatch): Promise<RemoteResult<CompactConfig>>
  removeModelPolicy(provider: string, model: string): Promise<RemoteResult<CompactConfig>>
}
