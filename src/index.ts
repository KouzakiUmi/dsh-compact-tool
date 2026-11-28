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
  mergePolicy,
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
import { COMPACTION_PLUGIN_NAME, compactionRows, effectiveCompactionRows, presetCompactionEntries, presetIdOf, type PluginRow } from './targets.js'

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

/** Per-provider cap for model discovery in `catalog()`. */
const LIST_MODELS_TIMEOUT_MS = 10_000

export class CompactToolController extends TypertRemoteService {
  static inject = ['llm', 'configEditor']

  /**
   * Background serial chain for secondary preset edits. The remote handler
   * only awaits the read target; the remaining preset entries drain here so
   * the response is not multiplied by `targets.length`. `configEditor.edit`
   * already serialises on `hmr.runExclusive`, so this chain only orders our
   * own background work — overlapping `editCompactions` calls append behind
   * whatever is in flight.
   */
  private pending: Promise<void> | undefined
  private writeLock: Promise<unknown> | undefined

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
    // Same identity rule as the preset rows: the loader instantiates by
    // module specifier (options.name), the id is only the mount key.
    const legacy = entries.find(
      candidate => candidate.options.id === COMPACTION_ENTRY_ID
        && candidate.options.name === COMPACTION_PLUGIN_NAME,
    )
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
    return this.configOfTarget(target)
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
   * The read target is edited first AND awaited: it feeds `currentConfig()`,
   * so the remote reply only reports success when the config the UI displays
   * was actually patched. Secondary targets drain on a background chain —
   * awaiting all presets is what multiplied one save by `targets.length`.
   * A failure on a *secondary* target (e.g. an unmounted or mid-remount
   * preset) is logged and tolerated — propagating it would return
   * `ok: false` while the visible config already persisted, which is exactly
   * the "click does nothing but reopen shows it applied" trap.
   * @returns number of entries edited (the awaited primary edit counts as 1).
   */
  private async editCompactions(
    mutate: (config: CompactConfig) => void,
    /**
     * Keys this write touches, for catch-up convergence: when a secondary
     * preset's edit fails and is retried late, only THESE keys converge to
     * the read target's fresh truth — a write that only touched `auto` must
     * not erase the secondary preset's own summarization route or retention
     * overrides. Keys NOT in this set keep whatever the secondary preset
     * independently holds.
     */
    /**
     * Keys are the written scalar keys (`true`) plus the optional
     * `modelPolicies` route list describing which (provider, model) rows the
     * write touched — the array replaces wholesale on the wire, but the
     * catch-up converges row-scoped so independent rows on the failed preset
     * survive (see the copy loop inside the catch-up change callback).
     */
    convergence: Readonly<Record<string, unknown>>,
  ): Promise<number> {
    // Serialize whole writes, INCLUDING the background drains of earlier
    // ones: a drain replays THIS write's mutation, so if a newer write's
    // primary edit were allowed to land before an older drain finished, the
    // older drain would overwrite the newer truth afterwards (observed end
    // state 0.9/0.9/0.6 with two rapid writes — the stale drain silently
    // reverted the newer write on the secondary presets). The client write
    // queue serializes per scope, but different scopes and direct remote
    // callers can still overlap, so the lock lives host-side.
    const task = (this.writeLock ?? Promise.resolve()).then(async () => {
      await (this.pending ?? Promise.resolve())
      return this.editCompactionsInner(mutate, convergence)
    })
    this.writeLock = task.then(() => undefined, () => undefined)
    return task
  }

  private async editCompactionsInner(
    mutate: (draft: CompactConfig) => void,
    convergence: Readonly<Record<string, unknown>>,
  ): Promise<number> {
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
    const editTarget = async (target: Target): Promise<void> => {
      const rows = target.rows
      const change: EntryEdit = rows === undefined
        ? (current) => {
            // Same certifiability union as the preset path, single-config
            // scope: Rule A (write positions inside already-deferred steps)
            // plus Rule B (deferrals the write itself creates — the multiset
            // comparison is the only change between the two validations).
            const legacyPreBag = new Map<string, number>()
            let legacyPreValid = true
            try {
              validateCompactConfig(structuredClone(current) as CompactConfig, legacyPreBag)
            } catch {
              legacyPreValid = false
            }
            const draft = structuredClone(current) as CompactConfig
            mutate(draft)
            // The legacy row IS the whole plugin config: validate it directly.
            const legacyDeferred = new Map<string, number>()
            validateCompactConfig(draft, legacyDeferred)
            const legacyWritten = writtenPositionsFromConvergence(convergence)
            const legacyUncertified = [...legacyDeferred.keys()].filter(position => {
              if (writesDeferredPosition(legacyWritten, position)) return true
              const preCount = legacyPreValid ? (legacyPreBag.get(position) ?? 0) : 0
              return (legacyDeferred.get(position) ?? 0) > preCount
            })
            if (legacyUncertified.length > 0) {
              throw new RemoteError(
                'compact-tool/uncertifiable',
                `compact-tool refused the write: the write's positions participate in validation steps deferred by unevaluated expressions (${legacyUncertified.join(', ')}) — the engine re-validates after evaluation and may reject the written values; edit the file or replace the expression first`,
                {},
              )
            }
            return draft as Record<string, unknown>
          }
        : (current) => {
            // Mutate only the rows the engine consumes. Shadowed rows
            // (same-id duplicates collapsed by the loader's last-wins, rows
            // inside shadowed subtrees) never mount: rewriting them is dead
            // weight, and worse — an expression-shaped or pre-broken shadow
            // row would crash or fail validation of a write whose EFFECTIVE
            // content is perfectly legal.
            const certSnapshots = new Map<unknown, { hadConfig: boolean, snapshot: Record<string, unknown> }>()
            // Pre-write validation multisets: certifiability is not only
            // "does the write land inside a step already deferred" — a write
            // can also CREATE a deferred step that did not exist before
            // (clearing a row's concrete thresholdRatio re-routes the row's
            // retention comparison onto the global marker; a wholesale array
            // introduces rows whose checks defer). Compare per-row multisets
            // before and after the mutation: any deferral that appears or
            // grows is caused by this write by construction, and the write
            // cannot certify it. Rows already invalid before the write have
            // no trustworthy baseline — their pre-write bag counts as empty
            // (conservative: repairing writes over dynamic content may be
            // refused, the safe direction).
            const preValidate = new Map<unknown, { bag: Map<string, number>, valid: boolean }>()
            for (const row of effectiveCompactionRows(current.plugins)) {
              certSnapshots.set(row, {
                hadConfig: row.config !== undefined,
                snapshot: structuredClone((row.config ?? {}) as Record<string, unknown>),
              })
              const bag = new Map<string, number>()
              let valid = true
              try {
                validateCompactConfig((row.config ?? {}) as CompactConfig, bag)
              } catch {
                valid = false
              }
              preValidate.set(row, { bag, valid })
            }
            for (const row of effectiveCompactionRows(current.plugins)) {
              const config = (row.config ?? {}) as CompactConfig
              mutate(config)
              // An empty object serialises as `config: {}`, while the bundle
              // layer declares that row with NO config key. Keeping `{}` makes
              // `next` differ from `inherited` forever, so ConfigEditor never
              // removes the override row and rewrites the whole plugin list on
              // every write. Restore the "no config key" shape when empty.
              if (isEmptyConfig(config)) delete row.config
              else row.config = config
            }
            // Validate what the ENGINE will load, not a merged invention:
            // the loader dedupes duplicate ids within one group (last row
            // wins) and mounts each surviving row as its own compaction-basic
            // instance, validated independently by resolveConfig. Rows in
            // different groups never merge, so a cross-row merge here would
            // both reject legal configs (split retain pairs in sibling rows
            // never coexist in one engine) and accept illegal ones (a broken
            // last row hidden under an earlier row's complementary keys).
            // Throwing inside the change callback aborts the edit before
            // anything is written.
            const deferred = new Map<string, number>()
            const postBags = new Map<unknown, Map<string, number>>()
            for (const row of effectiveCompactionRows(current.plugins)) {
              const bag = new Map<string, number>()
              validateCompactConfig((row.config ?? {}) as CompactConfig, bag)
              postBags.set(row, bag)
              for (const [position, count] of bag) {
                deferred.set(position, (deferred.get(position) ?? 0) + count)
              }
            }
            // Certifiability gate: validation PASSED, but some comparisons
            // were skipped because a marker participates in them. When the
            // write's own positions intersect those deferred steps the
            // write's values are exactly what cannot be certified — the
            // step's outcome depends on an evaluated expression, so the
            // write can persist a configuration the engine rejects after
            // evaluation while every static check passes (observed: a row
            // retainRatio written onto a preset whose top-level
            // thresholdRatio is a !!js expression). Removal-only writes
            // carry no positions and can never intersect. The primary
            // target rejects loudly (the write must not silently pretend);
            // a secondary target byte-restores its rows and stays diverged
            // with a warning — applying the write there would persist the
            // uncertified state the gate exists to prevent.
            const written = writtenPositionsFromConvergence(convergence)
            const uncertifiedSet = new Set<string>()
            // Rule A: the write's own positions intersect steps already
            // deferred — the written values are exactly what cannot be
            // certified. A whole-array write claims all model-policy positions.
            for (const position of deferred.keys()) {
              if (writesDeferredPosition(written, position)) uncertifiedSet.add(position)
            }
            // Rule B: deferrals that appear or grow between the pre-write
            // and post-write multisets are caused by this write by
            // construction (nothing else changed in between).
            for (const row of effectiveCompactionRows(current.plugins)) {
              const post = postBags.get(row)
              if (post === undefined) continue
              const pre = preValidate.get(row)
              const preBag = pre !== undefined && pre.valid ? pre.bag : undefined
              for (const [position, count] of post) {
                const preCount = preBag?.get(position) ?? 0
                if (count > preCount) uncertifiedSet.add(position)
              }
            }
            const uncertified = [...uncertifiedSet]
            if (uncertified.length > 0) {
              const detail = `the write's positions participate in validation steps deferred by unevaluated expressions (${uncertified.join(', ')}) — the engine re-validates after evaluation and may reject the written values; edit the preset file or replace the expression first`
              if (target === read) {
                throw new RemoteError('compact-tool/uncertifiable', `compact-tool refused the write: ${detail}`, {})
              }
              for (const row of effectiveCompactionRows(current.plugins)) {
                const snap = certSnapshots.get(row)
                if (snap === undefined) continue
                if (snap.hadConfig) row.config = snap.snapshot
                else delete row.config
              }
              this.ctx.logger.warn(
                `dsh-compact-tool: write skipped on secondary preset "${target.preset ?? target.entry.options.id}": ${detail}; the preset stays diverged on the written keys`,
              )
            }
            return current
          }
      await this.editEntry(target.entry, change)
    }
    // Await only the read target: `currentConfig()` reads it, so the remote
    // reply must only land after the config the UI displays was patched.
    // Remaining presets run on the background chain — awaiting all five
    // `configEditor.edit` calls is what made one save take several seconds.
    const started = Date.now()
    await editTarget(read)
    this.ctx.logger.info(
      `dsh-compact-tool: primary edit committed on "${read.preset ?? read.entry.options.id}" in ${Date.now() - started}ms`,
    )
    // Freeze the truth SOURCE identity NOW, at write time. The catch-up drain
    // must read the newest truth CONTENT (never a write-time snapshot — a
    // stale snapshot would revert newer writes) but always from the preset
    // this write actually patched: re-resolving the read target at drain time
    // follows a mid-write default-preset switch and copies the NEW default's
    // old values over themselves — the write reports success while the
    // current read target still shows its old policy (observed: default
    // switched A→B mid-drain, B converged to B's own pre-write value).
    const truthSource = { preset: read.preset, entryId: read.entry.options.id }
    const secondary = targets.filter(target => target !== read)
    if (secondary.length === 0) return 1
    const drain = async (): Promise<void> => {
      const failed: Target[] = []
      for (const target of secondary) {
        try {
          const t0 = Date.now()
          await editTarget(target)
          this.ctx.logger.info(
            `dsh-compact-tool: secondary edit committed on "${target.preset ?? target.entry.options.id}" in ${Date.now() - t0}ms`,
          )
        } catch (error) {
          const label = target.preset ?? target.entry.options.id
          this.ctx.logger.warn(
            `dsh-compact-tool: skipped preset "${label}" after primary edit succeeded: ${error instanceof Error ? error.message : String(error)}`,
          )
          failed.push(target)
        }
      }
      // Catch-up pass (M4): a secondary preset whose edit failed even after
      // the transient retry inside editEntry used to stay diverged forever —
      // sessions routed through that preset silently ran the OLD policy.
      // Copy the read target's CURRENT row truth instead of replaying this
      // write's mutation: configEditor edits are serialized inside the host,
      // so the primary's state at drain time already includes every write
      // committed before this drain ran (including a newer write whose own
      // drain is still queued behind us — replaying the OLD mutation would
      // have overwritten that newer truth and diverged the preset until yet
      // another write arrived). Copying converges no matter which writes
      // raced, and it also repairs partial divergences a replay never would
      // (a preset whose failed edit only carried `auto` now receives the
      // full current policy).
      // Nothing to converge when the mutation touched no keys (a no-op
      // patch): there is no newer truth to copy and no legal drift to repair.
      const convergenceKeys = Object.keys(convergence)
      if (convergenceKeys.length === 0) return
      for (const target of failed) {
        try {
          // Re-resolve the entry: a mid-remount preset is exactly what fails
          // the first time, and the stale handle cannot be retried.
          const freshTargets = this.targets()
          const fresh = freshTargets.find(
            candidate => candidate.preset !== undefined && candidate.preset === target.preset,
          ) ?? freshTargets.find(candidate => candidate.entry.options.id === target.entry.options.id)
          if (fresh === undefined) {
            this.ctx.logger.warn(`dsh-compact-tool: catch-up skipped for "${target.preset ?? target.entry.options.id}": target no longer mounted`)
            continue
          }
          const copyTruth: EntryEdit = (current) => {
            // Read the read target's truth HERE, at execution time inside the
            // serialized edit — never at write-schedule time. A stale
            // snapshot captured before newer writes committed would revert
            // those writes: when the failed target IS the newer write's
            // primary, that write's own drain never re-touches it, so the
            // reversion was permanent. ConfigEditor serializes edits, so
            // this read observes every write committed before this catch-up.
            const truth = this.truthFromSource(truthSource)
            if (truth === undefined) {
              this.ctx.logger.warn(
                `dsh-compact-tool: catch-up copy skipped on "${target.preset ?? target.entry.options.id}": the truth source preset is no longer mounted`,
              )
              return current
            }
            const preStates = new Map<unknown, { hadConfig: boolean, snapshot: Record<string, unknown>, valid: boolean, bag: Map<string, number> }>()
            for (const row of effectiveCompactionRows(current.plugins)) {
              const existing = (row.config ?? {}) as CompactConfig
              const bag = new Map<string, number>()
              let valid = true
              try {
                validateCompactConfig(existing, bag)
              } catch {
                valid = false
              }
              preStates.set(row, {
                hadConfig: row.config !== undefined,
                snapshot: structuredClone(existing) as Record<string, unknown>,
                valid,
                bag,
              })
            }
            for (const row of effectiveCompactionRows(current.plugins)) {
              const config = (row.config ?? {}) as CompactConfig
              // Converge ONLY the keys this write touched: the copy repairs
              // the divergence the failed write would have caused, but a key
              // the write never touched is the secondary preset's own
              // independent configuration (its own summarization route,
              // its own retention) and must survive. A key absent from the
              // fresh truth is deleted so deletion propagates too.
              const truthMap = truth as Record<string, unknown>
              const configMap = config as Record<string, unknown>
              for (const key of convergenceKeys) {
                if (key === 'modelPolicies') {
                  // Wholesale semantics only when patchGlobal carried the
                  // array verbatim (convergence value `true`) — the normal
                  // mutation replaced the whole array on every target, so the
                  // catch-up mirrors exactly that. Row writes converge
                  // row-scoped AND field-scoped instead: copying the truth
                  // row wholesale would erase fields the secondary preset set
                  // independently for the SAME route (its own summarization
                  // route on that row), which the per-target upsert mutation
                  // never touches.
                  const scopeValue = convergence.modelPolicies
                  if (scopeValue === true) {
                    // Wholesale semantics mirror the mutation's whole-array
                    // replacement EXACTLY — including over a jsExpr marker.
                    // An explicit patchGlobal({modelPolicies: [...]}) is the
                    // user's own wholesale write: the normal mutation replaced
                    // the array on every target, marker or not, so skipping
                    // catch-up here made the final configuration depend on
                    // whether the secondary edit happened to fail (same write,
                    // two outcomes — the reviewer observed exactly that).
                    // The marker skip below protects only ROW-scoped
                    // convergence, where the write never claimed the array.
                    if (truthMap.modelPolicies === undefined) delete configMap.modelPolicies
                    else configMap.modelPolicies = structuredClone(truthMap.modelPolicies)
                    continue
                  }
                  if (configMap.modelPolicies !== undefined && !Array.isArray(configMap.modelPolicies)) {
                    // The array is a jsExpr marker on this preset — managed
                    // outside the plugin's write domain (row writes already
                    // refused it loudly). Converging a literal array over the
                    // user's dynamic configuration is exactly the destruction
                    // the refusal exists to prevent, so skip and warn.
                    this.ctx.logger.warn(
                      `dsh-compact-tool: catch-up skipped modelPolicies convergence on "${target.preset ?? target.entry.options.id}": the preset's modelPolicies is a js expression`,
                    )
                    continue
                  }
                  const truthRows = policyRowsOf(truth)
                  const routes = (Array.isArray(scopeValue) ? scopeValue : []) as Array<{ provider: string, model: string, fields?: string[], deletionsOnly?: boolean }>
                  if (routes.length > 0) {
                    const rows = Array.isArray(configMap.modelPolicies)
                      ? [...configMap.modelPolicies] as Array<Record<string, unknown>>
                      : []
                    for (const route of routes) {
                      const truthRow = truthRows.find(
                        candidate => candidate.provider === route.provider && candidate.model === route.model,
                      ) as Record<string, unknown> | undefined
                      const index = rows.findIndex(
                        candidate => candidate.provider === route.provider && candidate.model === route.model,
                      )
                      if (route.fields === undefined) {
                        // Row-removal write: the truth carrying the row again
                        // means a NEWER write re-created it — mirror the
                        // newest truth in that case (deleting would fight the
                        // newer write); otherwise propagate the removal.
                        if (truthRow === undefined) {
                          if (index >= 0) rows.splice(index, 1)
                        } else if (index < 0) rows.push(structuredClone(truthRow))
                        else rows[index] = structuredClone(truthRow)
                        continue
                      }
                      if (truthRow === undefined) {
                        // The truth no longer carries this route. For a
                        // FIELD-scoped write that means the mutation removed
                        // those fields and then dropped the row because only
                        // provider/model remained — mirror exactly that:
                        // delete the written fields and drop the row ONLY
                        // when nothing else survives. A row carrying its own
                        // independent fields (this preset's own summarization
                        // route) must NOT be removed — the normal mutation
                        // would never have touched those either.
                        if (index >= 0) {
                          const targetRow = { ...(rows[index] as Record<string, unknown>) }
                          for (const field of route.fields) delete targetRow[field]
                          const survivors = Object.keys(targetRow).filter(
                            key => key !== 'provider' && key !== 'model' && targetRow[key] !== undefined,
                          )
                          if (survivors.length === 0) rows.splice(index, 1)
                          else rows[index] = targetRow
                        }
                        continue
                      }
                      if (index < 0) {
                        // Row absent here: mirror the mutation's upsert, NOT
                        // the whole truth row — the truth row may carry
                        // fields this write never touched (a summarization
                        // route written earlier on the primary), and copying
                        // them would replicate the primary's independent
                        // configuration onto a preset that never opted in
                        // (observed: an empty {} upsert meant to create a
                        // bare override row copied the truth's threshold AND
                        // summarization route). Start bare and apply only
                        // the written fields.
                        const created: Record<string, unknown> = { provider: route.provider, model: route.model }
                        for (const field of route.fields) {
                          if (truthRow[field] !== undefined) created[field] = structuredClone(truthRow[field])
                        }
                        const bare = Object.keys(created).every(key => key === 'provider' || key === 'model')
                        if (!(bare && route.deletionsOnly === true)) rows.push(created)
                        continue
                      }
                      // Row present on both sides: merge ONLY the written
                      // fields, preserving fields this preset set
                      // independently for the same route. A field absent from
                      // the truth is deleted so field-level deletion
                      // propagates too.
                      const target_row = { ...(rows[index] as Record<string, unknown>) }
                      for (const field of route.fields) {
                        if (truthRow[field] === undefined) delete target_row[field]
                        else target_row[field] = structuredClone(truthRow[field])
                      }
                      // Mirror the mutation's bare-row lifecycle: a write
                      // consisting purely of field deletions drops a row
                      // reduced to {provider, model} ("no override"), while
                      // any value-carrying upsert keeps even a bare row
                      // (an empty {} upsert CREATES one — the override
                      // exists). Converging without this rule left a bare
                      // row the normal mutation would have removed (the
                      // "reset" never reached the failed preset's file).
                      const bare = Object.keys(target_row).every(key => key === 'provider' || key === 'model')
                      if (bare && route.deletionsOnly === true) rows.splice(index, 1)
                      else rows[index] = target_row
                    }
                    if (rows.length === 0) delete configMap.modelPolicies
                    else configMap.modelPolicies = rows
                  }
                  continue
                }
                // Scalar keys: skip keys the primary manages by expression —
                // the evaluated value is unknowable here and copying the
                // marker verbatim would clone the expression into a preset
                // that never opted into dynamic configuration.
                const truthValue = truthMap[key]
                if (typeof truthValue === 'object' && truthValue !== null && '__jsExpr' in (truthValue as Record<string, unknown>)) continue
                if (truthValue === undefined) delete configMap[key]
                else configMap[key] = structuredClone(truthValue)
              }
              if (isEmptyConfig(config)) delete row.config
              else row.config = config
            }
            const catchDeferred = new Map<string, number>()
            const catchRowBags = new Map<unknown, Map<string, number> | null>()
            const mergeCatchBag = (row: unknown, bag: Map<string, number>): void => {
              catchRowBags.set(row, bag)
              for (const [position, count] of bag) {
                catchDeferred.set(position, (catchDeferred.get(position) ?? 0) + count)
              }
            }
            for (const row of effectiveCompactionRows(current.plugins)) {
              let error: unknown = null
              try {
                const bag = new Map<string, number>()
                validateCompactConfig((row.config ?? {}) as CompactConfig, bag)
                mergeCatchBag(row, bag)
                continue
              } catch (caught) {
                error = caught
              }
              const pre = preStates.get(row)
              if (pre !== undefined && pre.valid) {
                // The row was VALID before the copy and invalid after: the
                // copy itself produced the invalid combination (the truth's
                // written values clash with this preset's independent keys —
                // e.g. its own retainRatio exceeds the copied threshold).
                // That content is NOT pre-broken, so the destructive
                // full-copy fallback has no justification; restore the row
                // byte-for-byte and leave the written keys diverged. The
                // alternative — forcing convergence — would erase legal
                // independent configuration, which is worse than divergence.
                if (pre.hadConfig) row.config = pre.snapshot
                else delete row.config
                catchRowBags.set(row, null) // byte-restored: write-caused analysis not applicable
                this.ctx.logger.warn(
                  `dsh-compact-tool: catch-up convergence skipped for "${target.preset ?? target.entry.options.id}": the written values conflict with the preset's independent configuration (${error instanceof Error ? error.message : String(error)}); the preset stays diverged on the written keys until the next write`,
                )
                continue
              }
              // The row was ALREADY invalid before the copy: its surviving
              // content is engine-broken on its own (e.g. a user hand-edited
              // the preset file into an illegal shape). But when the row
              // carries ANY dynamic content, the repair copy cannot fire at
              // all. There is no statically-safe partial repair over
              // expressions, at any depth:
              //  - nested row expressions collide with copied truth ROWS at
              //    evaluation time (duplicate routes; a restored retainRatio
              //    expression combining with the copied literal threshold
              //    into a cross-scope violation);
              //  - top-level SCALAR expressions interact with copied content
              //    the same way — a thresholdRatio: !!js evaluating to 0.5
              //    next to a copied row whose retainRatio is 0.6 violates the
              //    cross-scope invariant the engine enforces AFTER evaluation;
              //    our static validator skips comparisons involving markers
              //    precisely because it cannot see them, so it cannot certify
              //    the combination either;
              //  - even a whole-array modelPolicies marker does not isolate
              //    the row: evaluated rows still INHERIT the copied global
              //    scalar fields, so an evaluated retainRatio 0.8 combines
              //    with the copied thresholdRatio 0.5 into the same runtime
              //    violation;
              //  - and restoring a top-level marker over the copied truth can
              //    silently undo the write itself: a wholesale modelPolicies
              //    write lands in the copy, then the fallback's marker
              //    restoration re-installs the OLD expression and the user's
              //    explicit array is gone while the request reported success.
              // A marker-bearing row is dynamic configuration managed outside
              // the write domain: restore it byte-for-byte and leave it
              // diverged, exactly like the valid-before/broken-after path.
              // Skipping is not a regression — the row was already
              // engine-broken before the write, and honest divergence with a
              // warning beats every alternative (destroying the user's
              // dynamic config, or committing a combination the engine will
              // reject at runtime). Only wholly STATIC rows get the repair
              // copy below.
              const hasDynamicContent = (value: unknown, depth = 0): boolean => {
                if (depth > 6 || value === null || typeof value !== 'object') return false
                if ('__jsExpr' in (value as Record<string, unknown>)) return true
                for (const entry of Object.values(value as Record<string, unknown>)) {
                  if (hasDynamicContent(entry, depth + 1)) return true
                }
                return false
              }
              if (pre !== undefined && pre.hadConfig && hasDynamicContent(pre.snapshot)) {
                row.config = pre.snapshot
                catchRowBags.set(row, null) // byte-restored: write-caused analysis not applicable
                this.ctx.logger.warn(
                  `dsh-compact-tool: catch-up convergence skipped for "${target.preset ?? target.entry.options.id}": the row is engine-invalid and carries dynamic (js expression) content, which the fallback repair cannot validate; the preset stays diverged until the dynamic content is fixed or the next write (${error instanceof Error ? error.message : String(error)})`,
                )
                continue
              }
              this.ctx.logger.warn(
                `dsh-compact-tool: preset "${target.preset ?? target.entry.options.id}" content outside the write scope is invalid (${error instanceof Error ? error.message : String(error)}); converging the full row to the read target's truth`,
              )
              const cloned = structuredClone(truth) as CompactConfig
              // No marker restoration here: dynamic rows never reach this
              // point (they skip the fallback above), and a static row has
              // no markers by definition.
              if (isEmptyConfig(cloned)) delete row.config
              else row.config = cloned
              const repairBag = new Map<string, number>()
              validateCompactConfig((row.config ?? {}) as CompactConfig, repairBag)
              mergeCatchBag(row, repairBag)
            }
            // Certifiability gate for the convergence itself: validation
            // passed on every surviving row, but the copied keys participate
            // in steps a marker deferred. Copying them would persist the
            // uncertified combination this write cannot vouch for — restore
            // every row byte-for-byte and leave the preset diverged, the
            // same shape as the other convergence skips.
            const catchWritten = writtenPositionsFromConvergence(convergence)
            const catchUncertifiedSet = new Set<string>()
            for (const position of catchDeferred.keys()) {
              if (writesDeferredPosition(catchWritten, position)) catchUncertifiedSet.add(position)
            }
            // Rule B on the convergence: the copied keys are the write's
            // positions, so any deferral that appears or grows between the
            // pre-copy row content and the copied state is caused by the copy
            // itself. Byte-restored rows (null) contribute nothing — their
            // content is byte-identical to the pre-copy state.
            for (const row of effectiveCompactionRows(current.plugins)) {
              const post = catchRowBags.get(row)
              if (post === undefined || post === null) continue
              const pre = preStates.get(row)
              const preBag = pre?.valid ? pre.bag : undefined
              for (const [position, count] of post) {
                const preCount = preBag?.get(position) ?? 0
                if (count > preCount) catchUncertifiedSet.add(position)
              }
            }
            const catchUncertified = [...catchUncertifiedSet]
            if (catchUncertified.length > 0) {
              for (const row of effectiveCompactionRows(current.plugins)) {
                const pre = preStates.get(row)
                if (pre === undefined) continue
                if (pre.hadConfig) row.config = pre.snapshot
                else delete row.config
              }
              this.ctx.logger.warn(
                `dsh-compact-tool: catch-up convergence skipped on "${target.preset ?? target.entry.options.id}": the written positions participate in validation steps deferred by unevaluated expressions (${catchUncertified.join(', ')}); the preset stays diverged on the written keys`,
              )
            }
            return current
          }
          await this.editEntry(fresh.entry, copyTruth)
          this.ctx.logger.info(`dsh-compact-tool: catch-up edit committed on "${fresh.preset ?? fresh.entry.options.id}"`)
        } catch (error) {
          this.ctx.logger.warn(
            `dsh-compact-tool: catch-up edit failed for "${target.preset ?? target.entry.options.id}"; the preset stays diverged until the next write: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
    // Append behind any previous background drain so secondary edits stay
    // ordered relative to each other across overlapping writes.
    this.pending = (this.pending ?? Promise.resolve()).then(drain, drain)
    this.pending.catch(() => undefined)
    return 1
  }

  /**
   * The read target's current compaction row truth for catch-up copies: the
   * merged effective config the engine would load right now. Read fresh at
   * drain time — never captured at write time — so a preset catching up late
   * converges to the newest truth, including writes committed after the drain
   * started.
   */
  /**
   * The newest compaction truth read from a FROZEN source preset (captured at
   * write time): targets are re-resolved so the content is current — every
   * write committed before this catch-up is visible — but the source never
   * follows a default-preset switch. Returns undefined when the source
   * preset is no longer mounted (nothing trustworthy left to copy).
   */
  private truthFromSource(source: { preset: string | undefined, entryId: string }): CompactConfig | undefined {
    const target = this.targets().find(
      candidate => source.preset !== undefined
        ? candidate.preset === source.preset
        : candidate.entry.options.id === source.entryId,
    )
    if (target === undefined) return undefined
    return this.configOfTarget(target)
  }

  /** The merged effective config of one target, mirroring the engine rows. */
  private configOfTarget(target: Target): CompactConfig {
    if (target.rows !== undefined) {
      const merged: Record<string, unknown> = {}
      for (const row of effectiveCompactionRows(target.entry.options.config?.plugins)) {
        if (row.config !== null && typeof row.config === 'object' && !('__jsExpr' in row.config)) {
          Object.assign(merged, row.config)
        }
      }
      return structuredClone(merged) as CompactConfig
    }
    return structuredClone((target.entry.options.config ?? {}) as CompactConfig)
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

  /**
   * Live provider routes plus each provider's advertised model catalog. A
   * provider whose `listModels` fails or exceeds `LIST_MODELS_TIMEOUT_MS`
   * contributes an empty list: one stalled adapter must not keep the whole
   * catalog pending, because the settings page cannot offer any model (or add
   * an override) until the catalog resolves.
   */
  @Remote
  async catalog(): Promise<CatalogResult> {
    const providers = this.llm.listProviders()
    const models: CatalogResult['models'] = {}
    await Promise.all(providers.map(async (provider) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const listed = await Promise.race([
          this.llm.listModels(provider.id),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(new Error('listModels timed out')) }, LIST_MODELS_TIMEOUT_MS)
          }),
        ])
        models[provider.id] = listed.map(model => ({
          provider: model.provider,
          model: model.id,
          name: model.name,
        }))
      } catch {
        models[provider.id] = []
      } finally {
        clearTimeout(timer)
      }
    }))
    return {
      providers: providers.map(provider => ({ id: provider.id, name: provider.name })),
      models,
    }
  }

  /**
   * Exact model metadata (context window) for the bar's capacity math.
   * `resolveModelInfo` has no internal timeout either: one stalled adapter
   * leaves the caller (the dialog's window lookup) pending forever, which
   * freezes the preview at "no window". Race it against the same cap
   * `catalog()` uses and report the timeout as an error the client can render
   * instead of an unsettled promise.
   */
  @Remote
  async modelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfoResult> {
    assertWireString('provider', provider)
    assertWireString('model', model)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const resolved = await Promise.race([
        this.llm.resolveModelInfo(provider, model, signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new Error(`resolveModelInfo timed out after ${LIST_MODELS_TIMEOUT_MS}ms`)) }, LIST_MODELS_TIMEOUT_MS)
        }),
      ])
      return {
        provider: resolved.provider,
        model: resolved.id,
        name: resolved.name,
        ...(resolved.context === undefined ? {} : { contextWindow: resolved.context.contextWindow }),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** The policy an exact route resolves to: global row + override + merge. */
  @Remote
  effectiveFor(provider: string, model: string): EffectiveResult {
    assertWireString('provider', provider)
    assertWireString('model', model)
    const config = this.currentConfig()
    const policy = policyRowsOf(config).find(
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
    const scope: Record<string, boolean> = {}
    for (const key of GLOBAL_KEYS) {
      if (Object.hasOwn(patch, key)) scope[key] = true
    }
    // An explicit modelPolicies patch replaces the whole array in both the
    // normal edit and catch-up. The UI uses row-scoped setModelPolicy instead.
    if (Object.hasOwn(patch, 'modelPolicies')) scope.modelPolicies = true
    await this.editCompactions((draft) => {
      for (const key of GLOBAL_KEYS) {
        if (!Object.hasOwn(patch, key)) continue
        const value = (patch as Record<string, unknown>)[key]
        if (value === null) delete draft[key]
        else (draft as Record<string, unknown>)[key] = value
      }
    }, scope)
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
      // An expression-valued `modelPolicies` (`!!js`) cannot be merged
      // row-wise: the engine evaluates it at load time, but this host never
      // sees the result, and overwriting the expression wholesale would
      // silently destroy the user's dynamic configuration. Reject loudly
      // instead of crashing on the spread of a non-iterable marker object.
      if (draft.modelPolicies !== undefined && !Array.isArray(draft.modelPolicies)) {
        throw new RemoteError(
          'compact-tool/expression-policies',
          'modelPolicies is a !!js expression; row-level overrides require a literal array — edit the preset file or replace the expression first',
          {},
        )
      }
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
    }, { modelPolicies: [{ provider, model, fields: Object.keys(fields), deletionsOnly }] })
    return this.currentConfig()
  }

  /** Remove the exact provider/model override row, restoring global defaults. */
  @Remote
  async removeModelPolicy(provider: string, model: string): Promise<CompactConfig> {
    assertWireString('provider', provider)
    assertWireString('model', model)
    await this.editCompactions((draft) => {
      if (draft.modelPolicies !== undefined && !Array.isArray(draft.modelPolicies)) {
        throw new RemoteError(
          'compact-tool/expression-policies',
          'modelPolicies is a !!js expression; row removal requires a literal array — edit the preset file or replace the expression first',
          {},
        )
      }
      const remaining = (draft.modelPolicies ?? []).filter(
        candidate => !(candidate.provider === provider && candidate.model === model),
      )
      if (remaining.length === 0) delete draft.modelPolicies
      else draft.modelPolicies = remaining
    }, { modelPolicies: [{ provider, model }] })
    return this.currentConfig()
  }
}


/**
 * Row view of `modelPolicies` for READ paths. The field can be a `!!js`
 * expression (`__jsExpr` marker object) instead of a literal array — the
 * engine evaluates it at load time, but nothing here can. Reads degrade to
 * an empty row list instead of crashing on `.find`/`.map`; writes that must
 * merge rows reject expression arrays explicitly (see setModelPolicy).
 */
function policyRowsOf(config: CompactConfig): ModelPolicyConfig[] {
  const rows = (config as Record<string, unknown>).modelPolicies
  return Array.isArray(rows) ? rows : []
}

/** Keep only the policy-shaped fields of a raw config row. */
function pickPolicy(config: CompactConfig): PolicyFields {
  const out: Record<string, unknown> = {}
  for (const key of POLICY_KEYS) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  return out
}

/**
 * Mirror of compaction-basic's `resolveConfig` load-time validation.
 *
 * ConfigEditor's own schema does not inspect the nested compaction config
 * (the preset schema stores `plugins` as an unvalidated array), so a structurally
 * invalid config would reach disk and kill compaction-basic on the next fiber
 * reload. Validating the post-mutation draft inside the change callback is the
 * last guard before disk: throwing aborts `configEditor.edit` and nothing is
 * written. Every rule below mirrors the engine byte-for-byte in semantics
 * (ratio range, integer class, mutual exclusion, pair rules, backfill chains,
 * duplicates, unknown keys) — the error prefix differs only in naming the
 * writer.
 *
 * `!!js`/`__jsExpr` marker values skip TYPE validation (the engine sees the
 * evaluated expression, which we cannot know), but they never exempt unknown
 * keys — key validation is about key NAMES, not values.
 */
/**
 * Written positions of one write, derived from its convergence descriptor.
 * The vocabulary mirrors the validator's deferral positions: `g.<key>` for
 * top-level scalars, `row:<provider>NUL<model>:<key>` for row keys, plus
 * `r.provider`/`r.model` matching the row-generic fallback positions of
 * expression-identified rows. The write ESTABLISHES a literal identity for
 * every route it touches (upsert or field edit), so the identity positions
 * are always included — the duplicate-detection step pairs them against
 * every other row. Whole-row removals are excluded: removing a row can only
 * eliminate validation steps, never create an uncertified one.
 */
function writtenPositionsFromConvergence(convergence: Readonly<Record<string, unknown>>): Set<string> {
  const written = new Set<string>()
  for (const [key, value] of Object.entries(convergence)) {
    if (key === 'modelPolicies') {
      if (value === true) written.add('g.modelPolicies')
      if (!Array.isArray(value)) continue
      for (const route of value as Array<{ provider?: unknown, model?: unknown, fields?: unknown }>) {
        if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') continue
        if (route.fields === undefined) continue
        // Upserts and field edits establish the route's literal identity:
        // the identity positions pair against every other row in duplicate
        // detection. Whole-row removals (no fields) contribute nothing —
        // removing a row can only eliminate validation steps.
        written.add('r.provider')
        written.add('r.model')
        const prefix = `row:${route.provider}\u0000${route.model}:`
        written.add(`${prefix}provider`)
        written.add(`${prefix}model`)
        for (const field of route.fields as string[]) written.add(`${prefix}${field}`)
      }
      continue
    }
    written.add(`g.${key}`)
  }
  return written
}

function writesDeferredPosition(written: ReadonlySet<string>, position: string): boolean {
  // Replacing an already deferred value might not change the pre/post counts.
  return written.has(position) || (written.has('g.modelPolicies') && /^r(?:ow:|[:.])/.test(position))
}

function validateCompactConfig(config: CompactConfig, deferred?: Map<string, number>): void {
  const fail = (message: string): never => {
    throw new RemoteError('compact-tool/invalid', `compact-tool rejected the write: ${message}`, {})
  }
  // Certifiability bookkeeping: positions are `g.<key>` for top-level keys
  // and `row:<provider>NUL<model>:<key>` for literal-addressable row keys
  // (NUL is the same separator duplicate detection uses). Rows whose
  // identity is itself an unevaluated expression cannot be addressed —
  // their positions fall back to the row-generic `r:<key>` form, which
  // intersects every row write conservatively.
  // The bag is a MULTISET (position -> count): two rows can defer the same
  // shared position, and certifiability compares pre/post multiplicities —
  // a write that adds a second expression-identity row must register even
  // though the position string already existed.
  const defer = (...positions: string[]): void => {
    if (deferred === undefined) return
    for (const position of positions) deferred.set(position, (deferred.get(position) ?? 0) + 1)
  }

  /** `!!js` unevaluated expression marker: type unknown until evaluation. */
  const isJsExpr = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).__jsExpr === 'string'

  // ── unknown keys (top-level row) ─────────────────────────────────────────
  const TOP_KEYS = new Set([
    'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens',
    'summarizationProvider', 'summarizationModel', 'maxTokens',
    'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto',
  ])
  for (const key of Object.keys(config)) {
    if (!TOP_KEYS.has(key)) fail(`unknown key "${key}"`)
  }

  // ── shared field validation (one scope) ─────────────────────────────────
  const validatePolicyFields = (scope: Record<string, unknown>, name: string, posPrefix = 'g.'): void => {
    const ratio = (key: string): void => {
      const value = scope[key]
      if (value === undefined) return
      if (isJsExpr(value)) {
        // An unevaluated expression at a typed position: the type/range
        // assertion cannot run, so the position defers itself. Writing the
        // marker lands the write inside its own deferred step — the written
        // value is exactly what cannot be certified (observed:
        // compactionRetries: !!js '-1' passed every static check and the
        // engine rejected it after evaluation).
        defer(`${posPrefix}${key}`)
        return
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
        fail(`${name}.${key} (${String(value)}) must be a number in (0, 1]`)
      }
    }
    const nonNegInt = (key: string): void => {
      const value = scope[key]
      if (value === undefined) return
      if (isJsExpr(value)) {
        defer(`${posPrefix}${key}`)
        return
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        fail(`${name}.${key} (${String(value)}) must be a non-negative integer`)
      }
    }
    const posInt = (key: string): void => {
      const value = scope[key]
      if (value === undefined) return
      if (isJsExpr(value)) {
        defer(`${posPrefix}${key}`)
        return
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        fail(`${name}.${key} (${String(value)}) must be a positive integer`)
      }
    }
    ratio('thresholdRatio')
    nonNegInt('headroomTokens')
    ratio('retainRatio')
    nonNegInt('retainTokens')
    if (scope.retainRatio !== undefined && scope.retainTokens !== undefined) {
      fail(`${name}: retainRatio and retainTokens are mutually exclusive`)
    }
    posInt('maxTokens')
    nonNegInt('compactionRetries')
    nonNegInt('maxOverflowRetries')
    // summarization pair — mirrors validateSummarizationPair: both absent is
    // fine, exactly one present is illegal, two plain strings must be equally
    // empty/non-empty. An unevaluated `!!js` side defers the pair check to the
    // engine (its value is unknown here).
    const provider = scope.summarizationProvider
    const model = scope.summarizationModel
    if (provider !== undefined && typeof provider !== 'string' && !isJsExpr(provider)) {
      fail(`${name}.summarizationProvider must be a string`)
    }
    if (model !== undefined && typeof model !== 'string' && !isJsExpr(model)) {
      fail(`${name}.summarizationModel must be a string`)
    }
    if (provider === undefined && model === undefined) {
      // both absent — nothing to check
    } else if (provider === undefined || model === undefined) {
      fail(`${name}: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair`)
    } else if (typeof provider === 'string' && typeof model === 'string'
      && (provider.length === 0) !== (model.length === 0)) {
      fail(`${name}: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair`)
    } else if (isJsExpr(provider) || isJsExpr(model)) {
      // An unevaluated side defers the pair check entirely: whether the
      // evaluated pair is consistent is unknowable here. Both positions
      // participate — a literal write to either lands in this comparison.
      defer(`${posPrefix}summarizationProvider`, `${posPrefix}summarizationModel`)
    }
  }

  validatePolicyFields(config as Record<string, unknown>, 'global')

  // auto boolean
  if (config.auto !== undefined && isJsExpr(config.auto)) {
    defer('g.auto')
  } else if (config.auto !== undefined && typeof config.auto !== 'boolean') {
    fail('auto must be a boolean')
  }

  // ── maxTokens backfill chain (global): the engine resolves
  //    maxTokens ?? headroomTokens ?? 65536, so headroomTokens:0 silently
  //    backfills maxTokens:0 → engine assertPositiveInteger fails. ──────────
  const globalHeadroom = config.headroomTokens
  // A concrete maxTokens stops the chain. An expression can evaluate to
  // undefined; in that case zero is the only legal headroom value that
  // becomes invalid when used as maxTokens. Positive headroom stays writable.
  const globalMaxMayBeAbsent = config.maxTokens === undefined || isJsExpr(config.maxTokens)
  if (isJsExpr(config.maxTokens) && globalHeadroom === 0) defer('g.headroomTokens')
  const globalChainPositions: string[] = []
  let globalMax: unknown = undefined
  let globalMaxFromMarker = false
  for (const [position, value] of [['g.maxTokens', config.maxTokens], ['g.headroomTokens', globalHeadroom]] as Array<[string, unknown]>) {
    if (value === undefined) {
      globalChainPositions.push(position) // consulted-and-absent: writing it re-routes this chain
      continue
    }
    globalChainPositions.push(position)
    globalMax = value
    globalMaxFromMarker = isJsExpr(value)
    break
  }
  if (globalMaxFromMarker) {
    // The resolved value is an unevaluated expression: the positive-integer
    // assertion cannot run. Every position consulted up to the marker
    // participates — a write to any of them re-routes or feeds this step.
    defer(...globalChainPositions)
  } else if (globalMax !== undefined) {
    if (typeof globalMax !== 'number' || !Number.isInteger(globalMax) || globalMax <= 0) {
      fail(`maxTokens (explicit or backfilled from headroomTokens) resolves to ${String(globalMax)}, which is not a positive integer — headroomTokens: 0 is a trap because the engine uses it as the maxTokens fallback`)
    }
  }

  // ── cross-field: effective retainRatio < effective thresholdRatio ────────
  // Numeric COMPARISONS can only run on concrete numbers: an unevaluated
  // `!!js` expression has an unknown value, so any comparison involving it
  // defers to the engine (it sees the evaluated result). Treating a marker
  // as absent and substituting the global default produced false rejections.
  const concrete = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : undefined
  const globalThreshold = concrete(config.thresholdRatio) ?? (isJsExpr(config.thresholdRatio) ? undefined : DEFAULTS.thresholdRatio)
  const validateRatioRetention = (
    thresholdRatio: number | undefined,
    retainRatio: number | undefined,
    name: string,
  ): void => {
    if (thresholdRatio !== undefined && retainRatio !== undefined && retainRatio >= thresholdRatio) {
      fail(`${name}: retainRatio (${retainRatio}) must be less than the resolved thresholdRatio (${thresholdRatio})`)
    }
  }
  const globalRetention = resolveRetention(config)
  const globalRetentionRatio = concrete(globalRetention.retainRatio)
  if (globalRetention.retainRatio !== undefined && (globalThreshold === undefined || globalRetentionRatio === undefined)) {
    // Ratio-mode retention whose comparison cannot run: a marker sits at the
    // threshold position, the retention position, or both. The FIXED mode is
    // structurally exempt from the load-time ratio check even when its value
    // is a marker (the engine branches on the key's presence, not its
    // evaluated content), so only ratio-mode resolution defers here.
    defer('g.thresholdRatio', 'g.retainRatio')
  }
  validateRatioRetention(globalThreshold, globalRetentionRatio, 'global')

  // ── modelPolicies ────────────────────────────────────────────────────────
  const policies = config.modelPolicies
  if (policies !== undefined && isJsExpr(policies)) {
    // The row array is an unevaluated expression: its rows are INVISIBLE.
    // Rows that materialise at evaluation time participate in validation
    // steps whose fallback positions live at global scope — the row ratio
    // comparison falls back to the global threshold/retention positions, and
    // the row maxTokens chain falls back to the global maxTokens/headroom
    // pair. Writing any of those globals cannot be certified against rows we
    // cannot see (observed: lowering thresholdRatio 0.8 → 0.5 beside a
    // modelPolicies expression evaluating to rows with retainRatio 0.6 —
    // every static check passed and the engine rejected the evaluated
    // combination). The conservative direction refuses the write; the escape
    // is a wholesale array write (which erases the marker) or editing the
    // expression itself. Row-scoped writes are already refused outright on
    // marker arrays (expression-policies), so no row-generic positions
    // belong here — duplicate detection between invisible rows is
    // unreachable through any write this gate covers.
    defer('g.modelPolicies', 'g.thresholdRatio', 'g.retainRatio', 'g.retainTokens', 'g.maxTokens', 'g.headroomTokens')
  } else if (policies !== undefined) {
    if (!Array.isArray(policies)) fail('modelPolicies must be an array')
    const seen = new Set<string>()
    const ROW_KEYS = new Set([
      'provider', 'model', 'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens',
      'summarizationProvider', 'summarizationModel', 'maxTokens', 'compactionRetries', 'maxOverflowRetries',
    ])
    for (const [index, source] of (policies as unknown[]).entries()) {
      const name = `modelPolicies[${index}]`
      if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        fail(`${name} must be an object`)
      }
      const row = source as Record<string, unknown>
      for (const key of Object.keys(row)) {
        if (!ROW_KEYS.has(key)) fail(`${name}: unknown key "${key}"`)
      }
      // provider/model carry the same js-expr exemption as every other typed
      // field: the engine evaluates them before validating.
      const providerIsExpr = isJsExpr(row.provider)
      const modelIsExpr = isJsExpr(row.model)
      if (!providerIsExpr && (typeof row.provider !== 'string' || row.provider === '')) {
        fail(`${name}.provider must be a non-empty string`)
      }
      if (!modelIsExpr && (typeof row.model !== 'string' || row.model === '')) {
        fail(`${name}.model must be a non-empty string`)
      }
      // Duplicate detection mirrors the engine exactly — separator NUL byte:
      // plain string concatenation collides for pairs like (ab,c)/(a,bc).
      // With either side unevaluated the identity is unknowable; skip rather
      // than guess (the engine re-checks after evaluation).
      if (!providerIsExpr && !modelIsExpr
        && typeof row.provider === 'string' && typeof row.model === 'string') {
        const key = `${row.provider}\u0000${row.model}`
        if (seen.has(key)) fail(`duplicate model policy for ${row.provider}/${row.model}`)
        seen.add(key)
      } else {
        // An unevaluated identity pairs against EVERY row in duplicate
        // detection: the row-generic positions intersect any write that
        // establishes a literal identity, conservatively.
        defer('r.provider', 'r.model')
      }
      const rowPrefix = typeof row.provider === 'string' && typeof row.model === 'string'
        ? `row:${row.provider}\u0000${row.model}:`
        : 'r:'
      const rowPos = (key: string): string => `${rowPrefix}${key}`
      validatePolicyFields(row, name, rowPrefix)
      // maxTokens backfill chain per row: the engine resolves
      // policy.maxTokens ?? (global.maxTokens undefined ? policy.headroomTokens : undefined) ?? global.maxTokens ?? global.headroomTokens
      // A zero row headroom can become maxTokens if both maxTokens values
      // are absent after evaluation, even when a marker hides that branch.
      if (row.headroomTokens === 0 && globalMaxMayBeAbsent
        && (row.maxTokens === undefined || isJsExpr(row.maxTokens))) {
        defer(rowPos('headroomTokens'))
      }
      const rowChain: Array<[string, unknown]> = [[rowPos('maxTokens'), row.maxTokens]]
      if (config.maxTokens === undefined) rowChain.push([rowPos('headroomTokens'), row.headroomTokens])
      rowChain.push(['g.maxTokens', config.maxTokens], ['g.headroomTokens', globalHeadroom])
      let rowMax: unknown = undefined
      let rowMaxFromMarker = false
      const rowConsulted: string[] = []
      for (const [position, value] of rowChain) {
        rowConsulted.push(position)
        if (value === undefined) continue
        rowMax = value
        rowMaxFromMarker = isJsExpr(value)
        break
      }
      if (rowMaxFromMarker) {
        defer(...rowConsulted)
      } else if (rowMax !== undefined) {
        if (typeof rowMax !== 'number' || !Number.isInteger(rowMax) || rowMax <= 0) {
          fail(`${name}.maxTokens (explicit or from headroomTokens) resolves to ${String(rowMax)}, which is not a positive integer`)
        }
      }

      // Cross-scope ratio retention: the row's effective threshold is its own
      // concrete value, the GLOBAL concrete value when unset, or UNKNOWN when
      // either side is an unevaluated expression — never substitute the global
      // default for an expression, that is a different number the user wrote.
      const rowThreshold = isJsExpr(row.thresholdRatio)
        ? undefined
        : (concrete(row.thresholdRatio) ?? globalThreshold)
      const rowRetentionResolved = resolveRetention(config, source as CompactConfig)
      const rowRetention = concrete(rowRetentionResolved.retainRatio)
      if (rowRetentionResolved.retainRatio !== undefined && (rowThreshold === undefined || rowRetention === undefined)) {
        // Ratio-mode retention with an unresolvable comparison. The
        // threshold position is the row's own when defined (even as a
        // marker — presence wins the resolution), otherwise the global one;
        // the retention position follows the same resolution chain. A write
        // to either source position participates in exactly this comparison.
        const thresholdSource = row.thresholdRatio !== undefined ? rowPos('thresholdRatio') : 'g.thresholdRatio'
        const retentionSource = row.retainRatio !== undefined ? rowPos('retainRatio')
          : row.retainTokens !== undefined ? rowPos('retainTokens')
            : config.retainTokens !== undefined ? 'g.retainTokens'
              : 'g.retainRatio'
        defer(thresholdSource, retentionSource)
      }
      validateRatioRetention(rowThreshold, rowRetention, `${name} (${String(row.provider)}/${String(row.model)})`)
    }
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
