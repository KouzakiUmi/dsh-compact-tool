/**
 * Wire + domain vocabulary shared by the host remote service and the client
 * bundle. Hand-mirrored from `@deepseek-ai/dsh-compaction-basic` (config.ts):
 * the plugin writes `compaction-basic`'s config object through the profile
 * ConfigEditor, so field names must stay byte-identical.
 */

/** compaction-basic plugin loader entry id (cordis.patch `id`). */
export const COMPACTION_ENTRY_ID = 'compaction-basic'

/** Remote namespace + Cordis service key owned by this plugin on the host. */
export const COMPACT_TOOL_NS = 'compactTool'

/** Fields of one compaction policy (global config or one modelPolicies row). */
export interface PolicyFields {
  thresholdRatio?: number | undefined
  headroomTokens?: number | undefined
  retainRatio?: number | undefined
  retainTokens?: number | undefined
  summarizationProvider?: string | undefined
  summarizationModel?: string | undefined
  maxTokens?: number | undefined
  compactionRetries?: number | undefined
  maxOverflowRetries?: number | undefined
}

/** Full raw config object stored under compaction-basic's patch entry. */
export interface CompactConfig extends PolicyFields {
  modelPolicies?: ModelPolicyConfig[] | undefined
  auto?: boolean | undefined
}

/** One exact provider/model override row. */
export interface ModelPolicyConfig extends PolicyFields {
  provider: string
  model: string
}

/** `patchGlobal` argument: value sets the key; null removes it. */
export type PolicyPatch = Partial<Record<keyof CompactConfig, unknown>>

/** Defaults duplicated from compaction-basic resolveConfig for UI hints. */
export const DEFAULTS = {
  thresholdRatio: 0.8,
  headroomTokens: 65_536,
  retainRatio: 0.16,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  auto: true,
} as const

type Retention = { retainRatio: number; retainTokens?: never } | { retainRatio?: never; retainTokens: number }

/** A model's explicit retention mode replaces the global mode as a unit. */
export function resolveRetention(global: PolicyFields, policy?: PolicyFields | null): Retention {
  if (policy?.retainTokens !== undefined) return { retainTokens: policy.retainTokens }
  if (policy?.retainRatio !== undefined) return { retainRatio: policy.retainRatio }
  if (global.retainTokens !== undefined) return { retainTokens: global.retainTokens }
  return { retainRatio: global.retainRatio ?? DEFAULTS.retainRatio }
}

/** describe() wire result. */
export interface DescribeResult {
  /** Whether a writable compaction-basic config was found at all. */
  available: boolean
  /** Logical entry id for the compaction plugin ('compaction-basic'). */
  entryId: string
  /** Preset ids whose `config.plugins` include a compaction group. */
  presets?: string[] | undefined
  /** The preset the read path resolved to (default preset when present). */
  presetId?: string | undefined
  /** Explicit config rows currently in the profile patch (detached). */
  config: CompactConfig
  /** Defaults after compaction-basic resolution, for placeholder display. */
  defaults: {
    thresholdRatio: number
    headroomTokens: number
    retainRatio: number
    compactionRetries: number
    maxOverflowRetries: number
    auto: boolean
  }
}

export interface ProviderInfo {
  id: string
  name: string
}

export interface ModelInfoLite {
  provider: string
  model: string
  name: string
}

export interface CatalogResult {
  providers: ProviderInfo[]
  /** provider id → models advertised by that provider's adapter. */
  models: Record<string, ModelInfoLite[]>
}

export interface ModelInfoResult {
  provider: string
  model: string
  name: string
  contextWindow?: number | undefined
}

/** effectiveFor() result: global row, matching override row, merged policy. */
export type MergedPolicy = Required<Omit<PolicyFields, 'retainTokens'>> & Pick<PolicyFields, 'retainTokens'>

export interface EffectiveResult {
  provider: string
  model: string
  global: PolicyFields & { auto: boolean }
  policy: ModelPolicyConfig | null
  merged: MergedPolicy
  /** Global policy resolved WITHOUT the override — the UI's reset target. */
  base: MergedPolicy
}
