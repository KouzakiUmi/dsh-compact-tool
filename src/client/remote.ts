/**
 * Hand-written Typert Remote contribution for the host's `compactTool`
 * namespace. The host service exposes @Remote-marked methods discovered
 * through the gateway's SRC (source-reflection) fallback, so no generated
 * typert artifact exists; these descriptors declare the same endpoints on the
 * client side. `requireStrictInputs` demands `mode:'strict'` parameter codecs,
 * but `create` is only materialized for tool-schema input descriptions — the
 * invocation path reads `parameters[].wire` and `result.mode` only, so a
 * pass-through stub satisfies validation.
 */

import type { TypertRemoteContribution, InvocationDescriptor } from './remote-types.js'
import { COMPACT_TOOL_NS } from '../shared.js'

const stub = () => ({
  mode: 'strict',
  typeSymbol: `dsh.${COMPACT_TOOL_NS}/arg`,
  create: () => ({ parse: (value: unknown) => value }),
}) as InvocationDescriptor['parameters'][number]['codec']

const jsonResult = () => ({ mode: 'src-json' }) as InvocationDescriptor['result']

function descriptor(
  method: string,
  parameters: Array<{ name: string }>,
  cancellation = false,
): InvocationDescriptor {
  return {
    id: `src:compactTool#${method}`,
    service: 'compactTool',
    namespace: COMPACT_TOOL_NS,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(parameter => ({
      name: parameter.name,
      wire: parameter.name,
      source: 'json',
      codec: stub(),
    })),
    ...(cancellation ? { cancellation: { parameter: 'signal' } } : {}),
    result: jsonResult(),
  } as InvocationDescriptor
}

export const compactToolRemote: TypertRemoteContribution = {
  package: '@mileskent/dsh-compact-tool',
  descriptors: [
    descriptor('describe', []),
    descriptor('catalog', []),
    descriptor('modelInfo', [{ name: 'provider' }, { name: 'model' }], true),
    descriptor('effectiveFor', [{ name: 'provider' }, { name: 'model' }]),
    descriptor('patchGlobal', [{ name: 'patch' }]),
    descriptor('setModelPolicy', [{ name: 'provider' }, { name: 'model' }, { name: 'fields' }]),
    descriptor('removeModelPolicy', [{ name: 'provider' }, { name: 'model' }]),
  ],
}

/**
 * The mounted `ctx.remote.compactTool` namespace, captured at apply time so
 * hooks/components reach it without threading ctx through injected props.
 */
import type { CompactToolCalls } from './remote-types.js'

let handle: CompactToolCalls | undefined

export function setRemoteHandle(next: CompactToolCalls | undefined): void {
  handle = next
}

export function remoteHandle(): CompactToolCalls {
  if (handle === undefined) {
    throw new Error('dsh-compact-tool: compactTool remote is not mounted (host plugin missing?)')
  }
  return handle
}
