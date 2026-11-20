/**
 * dsh-compact-tool host half: a small Typert Remote namespace (`compactTool`)
 * that edits `compaction-basic`'s config where it actually lives in a
 * preset-based composition — the `compaction` group of each agent preset's
 * `config.plugins` — through the same ConfigEditor surface the built-in Web
 * configuration editor uses. Writes reconcile the profile patch in place;
 * newly mounted sessions (and preset re-activations) pick up the change.
 *
 * Legacy layouts that still mount a host-level `compaction-basic` entry are
 * edited directly, so the plugin keeps working on older compositions.
 *
 * The package's default export is the Service class itself (the same
 * class-as-plugin shape `@deepseek-ai/dsh-api-settings-controller` ships), so
 * `name: 'dsh-compact-tool'` in the roster instantiates it with the plugin
 * context and config.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  COMPACTION_ENTRY_ID,
  COMPACT_TOOL_NS,
  DEFAULTS,
  resolveRetention,
  type CatalogResult,
  type CompactConfig,
  type DescribeResult,
  type EffectiveResult,
  type ModelInfoResult,
  type ModelPolicyConfig,
  type PolicyFields,
  type PolicyPatch,
} from './shared.js'
import { compactionRows, presetCompactionEntries, presetIdOf, type PluginRow } from './targets.js'

interface EditorEntry {
  readonly fiber?: { readonly state?: number | undefined } | undefined
  readonly options: {
    readonly id: string
    readonly name?: string | undefined
    readonly config?: Record<string, unknown> | undefined
  }
}

interface LlmFace {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>>
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ provider: string; id: string; name: string; context?: { contextWindow: number } | undefined }>
}

interface ConfigEditorFace {
  entries(): EditorEntry[]
  edit(
    entry: EditorEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** Agent-preset registry face; only `defaultId` is used, kept optional. */
interface AgentPresetsFace {
  readonly defaultId?: string | undefined
}

/** One writable compaction config location. */
interface Target {
  /** ConfigEditor entry whose `config` is edited. */
  entry: EditorEntry
  /** Preset identity for preset targets; undefined for the legacy row. */
  preset?: string | undefined
  /** Rows inside `entry.options.config.plugins` carrying the config. */
  rows?: PluginRow[] | undefined
}

type EntryEdit = (
  current: Record<string, unknown>,
  inherited: Record<string, unknown>,
) => Record<string, unknown>

/** Field whitelist for one policy (mirrors BasicCompactionConfig keys). */
const POLICY_KEYS = [
  'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens',
  'summarizationProvider', 'summarizationModel', 'maxTokens',
  'compactionRetries', 'maxOverflowRetries',
] as const

const GLOBAL_KEYS = [...POLICY_KEYS, 'modelPolicies', 'auto'] as const

export class CompactToolController extends TypertRemoteService {
  static inject = ['llm', 'configEditor']

  constructor(ctx: Context) {
    super(ctx, 'compactTool', { namespace: COMPACT_TOOL_NS })
    // Reload diagnostic: resolves the write targets once and logs how many
    // presets (or the legacy row) will receive edits. Read-only on purpose —
    // a real no-op edit() would still stamp a full `config` override row
    // into the profile patch for every preset (next != inherited), which is
    // noise this plugin should not write on every reload.
    const probe = setTimeout(() => {
      try {
        const targets = this.targets()
        const names = targets.map(target => target.preset ?? target.entry.options.id).join(',')
        this.ctx.logger.info(`dsh-compact-tool: ${targets.length} target(s): ${names}; default=${this.defaultPresetId ?? 'none'}`)
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-compact-tool: target resolution failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 4000)
    this.ctx.effect(() => () => clearTimeout(probe), 'compact-tool probe')
  }

  private get llm(): LlmFace {
    const llm = this.ctx.get('llm') as LlmFace | undefined
    if (llm === undefined) throw new RemoteError('compact-tool/unavailable', 'llm service is absent', {})
    return llm
  }

  private get configEditor(): ConfigEditorFace {
    const editor = this.ctx.get('configEditor') as ConfigEditorFace | undefined
    if (editor === undefined) {
      throw new RemoteError('compact-tool/unavailable', 'configEditor service is absent', {})
    }
    return editor
  }

  /** Default preset id from the registry, when that service is mounted. */
  private get defaultPresetId(): string | undefined {
    const presets = this.ctx.get('agentPresets') as AgentPresetsFace | undefined
    return presets?.defaultId
  }

  /**
   * Every writable compaction config location. Preset declaration entries
   * come first (each carries its own `compaction` group); the legacy
   * host-level `compaction-basic` row is used only when no preset declares
   * one — on preset compositions that row is disabled and cannot be edited.
   */
  private targets(): Target[] {
    const entries = this.configEditor.entries()
    const presets = presetCompactionEntries(entries)
    if (presets.length > 0) {
      return presets.map(entry => ({
        entry,
        preset: presetIdOf(entry.options.config),
        rows: compactionRows(entry.options.config?.plugins),
      }))
    }
    const legacy = entries.find(candidate => candidate.options.id === COMPACTION_ENTRY_ID)
    if (legacy !== undefined) return [{ entry: legacy }]
    return []
  }

  /** Read the default preset's compaction config (first target otherwise). */
  private readTarget(): Target | undefined {
    const found = this.targets()
    if (found.length === 0) return undefined
    const defaultId = this.defaultPresetId
    return found.find(target => target.preset !== undefined && target.preset === defaultId) ?? found[0]
  }

  /** Raw compaction-basic config of the read target (merged across rows). */
  private currentConfig(): CompactConfig {
    const target = this.readTarget()
    if (target === undefined) return {}
    if (target.rows !== undefined) {
      const merged: Record<string, unknown> = {}
      for (const row of target.rows) {
        if (row.config !== null && typeof row.config === 'object') Object.assign(merged, row.config)
      }
      return structuredClone(merged) as CompactConfig
    }
    return structuredClone((target.entry.options.config ?? {}) as CompactConfig)
  }

  /**
   * ConfigEditor.edit has two transient failure modes under HMR: a stale
   * entry handle ('Configuration entry is no longer available' / 'changed
   * during reload') when the Loader swaps Entry objects mid-edit, and
   * 'HMR transactions cannot be nested' when a module/config transaction is
   * still draining. Wait for the transaction to settle, re-resolve targets,
   * and retry once; the change callback re-runs against the freshest config.
   */
  private async editEntry(entry: EditorEntry, change: EntryEdit): Promise<void> {
    try {
      await this.configEditor.edit(entry, change)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const transient =
        message.includes('no longer available') ||
        message.includes('changed during reload') ||
        message.includes('cannot be nested') ||
        message.includes('no longer active')
      if (!transient) throw error
      this.ctx.logger.info(`dsh-compact-tool: transient edit failure on "${entry.options.id}" (${message}); retrying once`)
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    const fresh = this.configEditor.entries().find(
      candidate =>
        candidate.options.id === entry.options.id && candidate.options.name === entry.options.name,
    )
    if (fresh === undefined) {
      throw new RemoteError('compact-tool/unavailable', `entry "${entry.options.id}" disappeared during retry`, {})
    }
    await this.configEditor.edit(fresh, change)
  }

  /**
   * Apply `mutate` to every compaction-basic config row across all targets.
   * For preset entries the change callback rewrites the declaring entry's
   * `config.plugins` in place — the rows inside `current` are already
   * detached clones, so mutating them and returning `current` is the whole
   * write. For the legacy row the entry config *is* the compaction config.
   *
   * The read target is edited first: it feeds `currentConfig()`, so the
   * remote reply only reports success when the config the UI displays was
   * actually patched. A failure on a *secondary* target (e.g. an unmounted
   * or mid-remount preset) is logged and tolerated — propagating it would
   * return `ok: false` while the visible config already persisted, which is
   * exactly the "click does nothing but reopen shows it applied" trap.
   * @returns number of entries edited.
   */
  private async editCompactions(
    mutate: (config: CompactConfig) => void,
  ): Promise<number> {
    const changePolicy = (draft: CompactConfig): void => {
      mutate(draft)
      validateRetentionRatios(draft)
    }
    const targets = this.targets()
    if (targets.length === 0) {
      throw new RemoteError(
        'compact-tool/unavailable',
        `no preset declares "${COMPACTION_ENTRY_ID}" and the host row is not mounted`,
        {},
      )
    }
    // Resolve the read target from THIS SAME array. Calling `readTarget()`
    // here re-runs `targets()` and returns a different object identity, so
    // `targets.filter(t => t !== read)` keeps the duplicate and the default
    // preset is edited twice on every write (wasted full-config write, and a
    // second edit racing the HMR reload window).
    const defaultId = this.defaultPresetId
    const read = targets.find(
      target => target.preset !== undefined && target.preset === defaultId,
    ) ?? targets[0]!
    const ordered = [read, ...targets.filter(target => target !== read)]
    let first = true
    let edited = 0
    for (const target of ordered) {
      const rows = target.rows
      const change: EntryEdit = rows === undefined
        ? (current) => {
            const draft = structuredClone(current) as CompactConfig
            changePolicy(draft)
            return draft as Record<string, unknown>
          }
        : (current) => {
            for (const row of compactionRows(current.plugins)) {
              const config = (row.config ?? {}) as CompactConfig
              changePolicy(config)
              // An empty object serialises as `config: {}`, while the bundle
              // layer declares that row with NO config key. Keeping `{}` makes
              // `next` differ from `inherited` forever, so ConfigEditor never
              // removes the override row and rewrites the whole plugin list on
              // every write. Restore the "no config key" shape when empty.
              if (isEmptyConfig(config)) delete row.config
              else row.config = config
            }
            return current
          }
      try {
        await this.editEntry(target.entry, change)
        edited += 1
      } catch (error) {
        if (first) throw error
        const label = target.preset ?? target.entry.options.id
        this.ctx.logger.warn(
          `dsh-compact-tool: skipped preset "${label}" after primary edit succeeded: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      first = false
    }
    return edited
  }

  private sanitizePolicyPatch(patch: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {}
    for (const key of POLICY_KEYS) {
      if (Object.hasOwn(patch, key)) clean[key] = patch[key]
    }
    return clean
  }

  /** Read the raw compaction-basic config plus UI defaults. */
  @Remote
  describe(): DescribeResult {
    const targets = this.targets()
    const read = this.readTarget()
    return {
      available: read !== undefined,
      entryId: COMPACTION_ENTRY_ID,
      config: this.currentConfig(),
      defaults: { ...DEFAULTS },
      presets: targets
        .map(target => target.preset)
        .filter((preset): preset is string => preset !== undefined),
      ...(read?.preset === undefined ? {} : { presetId: read.preset }),
    }
  }

  /** Live provider routes plus each provider's advertised model catalog. */
  @Remote
  async catalog(): Promise<CatalogResult> {
    const providers = this.llm.listProviders()
    const models: CatalogResult['models'] = {}
    await Promise.all(providers.map(async (provider) => {
      try {
        models[provider.id] = (await this.llm.listModels(provider.id)).map(model => ({
          provider: model.provider,
          model: model.id,
          name: model.name,
        }))
      } catch {
        models[provider.id] = []
      }
    }))
    return {
      providers: providers.map(provider => ({ id: provider.id, name: provider.name })),
      models,
    }
  }

  /** Exact model metadata (context window) for the bar's capacity math. */
  @Remote
  async modelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfoResult> {
    assertWireString('provider', provider)
    assertWireString('model', model)
    const resolved = await this.llm.resolveModelInfo(provider, model, signal)
    return {
      provider: resolved.provider,
      model: resolved.id,
      name: resolved.name,
      ...(resolved.context === undefined ? {} : { contextWindow: resolved.context.contextWindow }),
    }
  }

  /** The policy an exact route resolves to: global row + override + merge. */
  @Remote
  effectiveFor(provider: string, model: string): EffectiveResult {
    assertWireString('provider', provider)
    assertWireString('model', model)
    const config = this.currentConfig()
    const policy = (config.modelPolicies ?? []).find(
      candidate => candidate.provider === provider && candidate.model === model,
    ) ?? null
    const merged = mergePolicy(config, policy)
    return {
      provider,
      model,
      global: {
        ...pickPolicy(config),
        auto: config.auto ?? DEFAULTS.auto,
      },
      policy: policy === null ? null : structuredClone(policy),
      merged,
      // `merged` still carries the override; the UI needs a stable global
      // baseline so a ⟲ reset shows the inherited value immediately instead
      // of waiting for a soft `effectiveFor` reload to land.
      base: mergePolicy(config, null),
    }
  }

  /**
   * Patch the global config object. Object fields are merged key-by-key;
   * a `null` value deletes the key. `modelPolicies` replaces wholesale.
   * @returns the read target's config after the patch committed.
   */
  @Remote
  async patchGlobal(patch: PolicyPatch): Promise<CompactConfig> {
    if (typeof patch !== 'object' || patch === null) {
      throw new RemoteError('compact-tool/invalid', 'patchGlobal expects an object patch', {})
    }
    await this.editCompactions((draft) => {
      for (const key of GLOBAL_KEYS) {
        if (!Object.hasOwn(patch, key)) continue
        const value = (patch as Record<string, unknown>)[key]
        if (value === null) delete draft[key]
        else (draft as Record<string, unknown>)[key] = value
      }
    })
    return this.currentConfig()
  }

  /**
   * Write or update one exact provider/model override. `fields` holds only
   * policy keys; a `null` value deletes that key from the existing override.
   * @returns the read target's config after the patch committed.
   */
  @Remote
  async setModelPolicy(provider: string, model: string, fields: PolicyPatch): Promise<CompactConfig> {
    assertWireString('provider', provider)
    assertWireString('model', model)
    if (typeof fields !== 'object' || fields === null) {
      throw new RemoteError('compact-tool/invalid', 'setModelPolicy expects an object of policy fields', {})
    }
    const entries = Object.entries(this.sanitizePolicyPatch(fields))
    const deletionsOnly = entries.length > 0 && entries.every(([, value]) => value === null)
    await this.editCompactions((draft) => {
      const policies = [...(draft.modelPolicies ?? [])]
      const index = policies.findIndex(
        candidate => candidate.provider === provider && candidate.model === model,
      )
      const base: Record<string, unknown> = index < 0
        ? { provider, model }
        : { ...(policies[index] as unknown as Record<string, unknown>) }
      for (const [key, value] of entries) {
        if (value === null) delete base[key]
        else base[key] = value
      }
      // A row left with only {provider, model} is indistinguishable from "no
      // override", but `policy !== null` keeps the "custom policy" checkbox
      // checked forever after the last field is reset to inherit (⟲). Drop it
      // when this call consisted purely of field deletions.
      if (deletionsOnly && Object.keys(base).length <= 2) {
        if (index >= 0) policies.splice(index, 1)
      } else {
        const row = base as unknown as ModelPolicyConfig
        if (index < 0) policies.push(row)
        else policies[index] = row
      }
      if (policies.length === 0) delete draft.modelPolicies
      else draft.modelPolicies = policies
    })
    return this.currentConfig()
  }

  /** Remove the exact provider/model override row, restoring global defaults. */
  @Remote
  async removeModelPolicy(provider: string, model: string): Promise<CompactConfig> {
    assertWireString('provider', provider)
    assertWireString('model', model)
    await this.editCompactions((draft) => {
      const remaining = (draft.modelPolicies ?? []).filter(
        candidate => !(candidate.provider === provider && candidate.model === model),
      )
      if (remaining.length === 0) delete draft.modelPolicies
      else draft.modelPolicies = remaining
    })
    return this.currentConfig()
  }
}

/** Keep only the policy-shaped fields of a raw config row. */
function pickPolicy(config: CompactConfig): PolicyFields {
  const out: Record<string, unknown> = {}
  for (const key of POLICY_KEYS) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  return out
}

/** Merge one override over the global row with compaction-basic's defaults. */
function mergePolicy(
  global: CompactConfig,
  policy: ModelPolicyConfig | null,
): EffectiveResult['merged'] {
  const retention = resolveRetention(global, policy)
  return {
    thresholdRatio: policy?.thresholdRatio ?? global.thresholdRatio ?? DEFAULTS.thresholdRatio,
    headroomTokens: policy?.headroomTokens ?? global.headroomTokens ?? DEFAULTS.headroomTokens,
    retainRatio: retention.retainRatio ?? DEFAULTS.retainRatio,
    ...retention,
    summarizationProvider:
      policy?.summarizationProvider ?? global.summarizationProvider ?? '',
    summarizationModel: policy?.summarizationModel ?? global.summarizationModel ?? '',
    maxTokens:
      policy?.maxTokens ??
      global.maxTokens ??
      global.headroomTokens ??
      DEFAULTS.headroomTokens,
    compactionRetries: policy?.compactionRetries ?? global.compactionRetries ?? DEFAULTS.compactionRetries,
    maxOverflowRetries:
      policy?.maxOverflowRetries ?? global.maxOverflowRetries ?? DEFAULTS.maxOverflowRetries,
  }
}

/** ConfigEditor validates the preset entry itself. Check its nested policy before it writes. */
function validateRetentionRatios(config: CompactConfig): void {
  const threshold = config.thresholdRatio ?? DEFAULTS.thresholdRatio
  const validate = (scope: string, ratio: number | undefined, trigger: number): void => {
    if (ratio !== undefined && ratio >= trigger) {
      throw new RemoteError('compact-tool/invalid', `${scope}: retainRatio (${ratio}) must be less than thresholdRatio (${trigger})`, {})
    }
  }
  validate('Global policy', resolveRetention(config).retainRatio, threshold)
  for (const policy of config.modelPolicies ?? []) {
    validate(`${policy.provider}/${policy.model}`, resolveRetention(config, policy).retainRatio, policy.thresholdRatio ?? threshold)
  }
}

/** Non-empty string guard for wire parameters. */
function assertWireString(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw new RemoteError('compact-tool/invalid', `${field} must be a non-empty string`, {})
  }
}

/** Plain empty object (not a `!!js` marker, not an array). */
function isEmptyConfig(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value as Record<string, unknown>).length === 0
}

export default CompactToolController
