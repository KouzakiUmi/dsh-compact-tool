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

/** One row of a preset's `config.plugins` entry list (kept opaque). */
export interface PluginRow {
  id?: string | undefined
  name?: string | undefined
  group?: boolean | undefined
  config?: unknown
  [key: string]: unknown
}

/**
 * Every `compaction-basic` child row reachable in a preset plugin list,
 * including rows nested under `cordis:group` containers whose child entries
 * live in their own `config` array. Top-level rows are matched by id.
 */
export function compactionRows(plugins: unknown): PluginRow[] {
  if (!Array.isArray(plugins)) return []
  const rows: PluginRow[] = []
  for (const row of plugins as Array<PluginRow | null>) {
    if (row === null || typeof row !== 'object') continue
    if (row.id === COMPACTION_ENTRY_ID) rows.push(row)
    // A cordis:group row's `config` field is itself an entry list.
    if (Array.isArray(row.config)) rows.push(...compactionRows(row.config))
  }
  return rows
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
