/**
 * Locating the writable compaction config in a preset-based composition.
 *
 * Newer DSH builds mount `compaction-basic` inside each agent preset's
 * isolated `compaction` group (declared in `dsh-web-app/presets/*.patch.yml`),
 * while the host-level `compaction-basic` row stays disabled. The sanctioned
 * persistence surface — the same one the built-in Web configuration editor
 * uses — is the preset declaration entry's `config.plugins` list, edited
 * through ConfigEditor as a whole-config override. `!!js` expressions inside
 * the list survive the round-trip via `__jsExpr` markers.
 *
 * Everything preset-list-shaped lives here so `index.ts` only speaks in
 * "compaction row" terms.
 */

import { COMPACTION_ENTRY_ID } from './shared.js'

/** Plugin name every agent-preset declaration entry carries. */
export const AGENT_PRESET_NAME = '@deepseek-ai/dsh-agent-preset'

/**
 * The compaction plugin's MODULE SPECIFIER — the row identity that decides
 * what the loader instantiates. `EntryOptions.name` is the import specifier
 * while `id` is only the tree-local mount key: a row carrying
 * `id: 'compaction-basic'` but another (or no) name never mounts
 * compaction-basic — it mounts whatever its name resolves to, and writing
 * compaction keys into its config corrupts THAT plugin (observed: a plain
 * plugin row shadowing the real compaction row's id inside one group had
 * `auto:false` written into the wrong plugin's config while the write
 * reported success). Only rows whose name resolves to the compaction module
 * are compaction rows.
 */
export const COMPACTION_PLUGIN_NAME = '@deepseek-ai/dsh-compaction-basic'

/** A row is a compaction row only when the loader would instantiate it as the compaction plugin. */
export function isCompactionRow(row: PluginRow): boolean {
  return row.id === COMPACTION_ENTRY_ID && row.name === COMPACTION_PLUGIN_NAME
}

/** One row of a preset's `config.plugins` entry list (kept opaque). */
export interface PluginRow {
  id?: string | undefined
  name?: string | undefined
  group?: boolean | undefined
  config?: unknown
  [key: string]: unknown
}

/**
 * A row is a container only when it mounts the loader's nested-group builtin:
 * the loader decides "is this entry a group" by the PLUGIN it resolves to
 * (`cordis:group` carries `static [EntryGroup.key]`), never by the shape of
 * its config. An array-shaped `config` on any other row is opaque plugin
 * data — recursing into it invented entries that never exist and let random
 * plugin data (an object carrying `id: compaction-basic` inside some other
 * plugin's settings) block or mutate compaction writes.
 *
 * Known limitation: third-party plugins that are themselves loader groups
 * (carrying `EntryGroup.key`) are not recognized here, so their nested
 * entries are invisible to this plugin. In practice presets declare only
 * `cordis:group` containers.
 */
function isContainerRow(row: PluginRow): boolean {
  return Array.isArray(row.config) && row.name === 'cordis:group'
}

/** One occurrence of an entry row in tree-flattened document order. */
interface Occurrence {
  row: PluginRow
  seq: number
  /** Ids (seqs) of the container rows this occurrence is nested under. */
  ancestors: readonly number[]
  /** Key of the containing list, for validation grouping. */
  containerKey: string
}

/**
 * Flatten every entry row in document order, descending into ALL container
 * rows regardless of survival — survival is computed afterwards, because
 * whether a container mounts depends on id collisions across the whole tree.
 */
function flattenTree(plugins: unknown): Occurrence[] {
  if (!Array.isArray(plugins)) return []
  const out: Occurrence[] = []
  let next = 0
  const walk = (list: Array<PluginRow | null>, ancestors: readonly number[], containerKey: string): void => {
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue
      const seq = next
      next += 1
      out.push({ row, seq, ancestors, containerKey })
      if (isContainerRow(row)) {
        walk(row.config as Array<PluginRow | null>, [...ancestors, seq], `${containerKey}/${seq}`)
      }
    }
  }
  walk(plugins as Array<PluginRow | null>, [], 'root')
  return out
}

/**
 * Tree-wide last-wins survival, mirroring the loader. The loader dedupes
 * entries by id twice:
 *  - within one group's list, `EntryGroup.update` builds `Object.fromEntries`
 *    — the last row of each id in that list wins;
 *  - across groups of the same tree all groups share one `EntryTree.store`:
 *    `create()` reuses the existing Entry object for a colliding id and
 *    re-parents it, so the entry only lives in the group that created it
 *    LAST — the earlier group's same-id row never mounts at all.
 * Both collapse to "the last occurrence wins tree-wide". Document order
 * approximates creation order (the real initial reconcile parallelizes group
 * creation, so exact order is implementation-defined; last-in-document is
 * the stable deterministic model and matches within-group dedupe exactly).
 *
 * Rows inside a dead container's subtree never enter the store, so they
 * cannot win collisions — survival is a fixed point: drop occurrences nested
 * under dead containers, recompute winners, repeat until stable (depth-bounded).
 */
function liveTreeRows(plugins: unknown): Occurrence[] {
  const all = flattenTree(plugins)
  // Same-list positional dedupe is static: `EntryGroup.update` builds
  // `Object.fromEntries` over each list independently of anything else's
  // survival, so the last row of each id within ONE list always wins.
  const positionalWinner = new Set<number>()
  const byList = new Map<string, Occurrence[]>()
  for (const occ of all) {
    const arr = byList.get(occ.containerKey)
    if (arr) arr.push(occ)
    else byList.set(occ.containerKey, [occ])
  }
  for (const arr of byList.values()) {
    const lastById = new Map<string, number>()
    for (const occ of arr) {
      if (typeof occ.row.id === 'string') lastById.set(occ.row.id, occ.seq)
    }
    for (const occ of arr) {
      if (typeof occ.row.id !== 'string' || lastById.get(occ.row.id) === occ.seq) positionalWinner.add(occ.seq)
    }
  }
  // Liveness is recursive: an occurrence mounts when it is its list's
  // positional winner, every ancestor container mounts, and no LATER
  // occurrence with the same id mounts (tree-wide last-wins through the
  // shared store). Crucially the suppressor must itself be live — a same-id
  // row inside a dead container's subtree never enters the store and cannot
  // shadow anything. Suppression edges point strictly forward in document
  // order and ancestor edges strictly upward, so memoized recursion
  // terminates; the only possible cycle is pathological same-id nesting
  // (a container carrying its own id inside itself), which the loader
  // cannot mount sanely either — the re-entrant call conservatively answers
  // "dead".
  const bySeq = new Map(all.map(occ => [occ.seq, occ]))
  const memo = new Map<number, boolean>()
  const visiting = new Set<number>()
  const isLive = (occ: Occurrence): boolean => {
    if (!positionalWinner.has(occ.seq)) return false
    const cached = memo.get(occ.seq)
    if (cached !== undefined) return cached
    if (visiting.has(occ.seq)) return false
    visiting.add(occ.seq)
    let live = true
    for (const ancestor of occ.ancestors) {
      if (!isLive(bySeq.get(ancestor)!)) { live = false; break }
    }
    if (live && typeof occ.row.id === 'string') {
      for (const other of all) {
        if (other.seq <= occ.seq || other.row.id !== occ.row.id) continue
        if (isLive(other)) { live = false; break }
      }
    }
    visiting.delete(occ.seq)
    memo.set(occ.seq, live)
    return live
  }
  return all.filter(occ => isLive(occ))
}

/**
 * Every LIVE `compaction-basic` row the loader would mount for this preset,
 * in document order. Dead rows — duplicates collapsed within their group,
 * entries shadowed tree-wide by a later same-id entry in another group of
 * the same tree, anything inside a dead container's subtree — never reach
 * the engine and are excluded here, so validation and mutation never reject
 * or rewrite config that does not exist at runtime.
 */
export function compactionRows(plugins: unknown): PluginRow[] {
  return liveTreeRows(plugins)
    .filter(occ => isCompactionRow(occ.row))
    .map(occ => occ.row)
}

/**
 * Live `compaction-basic` rows grouped by their CONTAINING list: one inner
 * array per entry list (the top-level `plugins` array or a live group's
 * `config` array). Each surviving row mounts its own compaction-basic
 * instance validated independently by `resolveConfig`; rows in different
 * groups never merge and never share a validation scope.
 */
export function compactionRowGroups(plugins: unknown): PluginRow[][] {
  const byContainer = new Map<string, PluginRow[]>()
  const order: string[] = []
  for (const occ of liveTreeRows(plugins)) {
    if (!isCompactionRow(occ.row)) continue
    if (!byContainer.has(occ.containerKey)) {
      byContainer.set(occ.containerKey, [])
      order.push(occ.containerKey)
    }
    byContainer.get(occ.containerKey)!.push(occ.row)
  }
  return order.map(key => byContainer.get(key)!)
}

/**
 * The rows the engine actually consumes: per containing group, duplicate ids
 * collapse to the LAST row (mirroring `EntryGroup.update`'s
 * `Object.fromEntries` last-wins semantics); tree-wide shadowed rows are
 * already excluded by the live-row computation. Validation and read-back
 * must reason about these rows only — a config valid in a shadowed first row
 * but invalid in the surviving last row is what decides whether the plugin
 * loads.
 */
export function effectiveCompactionRows(plugins: unknown): PluginRow[] {
  const effective: PluginRow[] = []
  for (const group of compactionRowGroups(plugins)) {
    const last = group[group.length - 1]
    if (last !== undefined) effective.push(last)
  }
  return effective
}

/**
 * ConfigEditor entries that declare an agent preset containing at least one
 * `compaction-basic` row. `options.config.id` is the preset identity
 * (`standard`, `cordis`, `ptc`, ...).
 */
export function presetCompactionEntries<
  T extends { readonly options: { readonly name?: string | undefined; readonly config?: Record<string, unknown> | undefined } },
>(entries: readonly T[]): T[] {
  return entries.filter(
    entry =>
      entry.options.name === AGENT_PRESET_NAME &&
      compactionRows(entry.options.config?.plugins).length > 0,
  )
}

/** Preset identity carried by a preset declaration entry's config. */
export function presetIdOf(config: Record<string, unknown> | undefined): string | undefined {
  const id = config?.id
  return typeof id === 'string' ? id : undefined
}
