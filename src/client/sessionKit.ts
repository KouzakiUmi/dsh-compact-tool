/**
 * Session-scoped slot kit shared by the composer-dock entry and the model-
 * menu gear entry. Owns the typed projection faces (structural shapes of the
 * host projection keys this plugin reads) plus small derived-value hooks, so
 * the entry components stay presentational.
 */

import { useMemo } from 'react'

/** The projection hook session slots inject (generic signature in host code). */
export type UseProjection = (key: string) => Record<string, unknown> | undefined

/** `modelSelection` projection view shape (dsh-agent model-selection.ts). */
export interface ModelSelectionView {
  /** In-flight choice wins over the persisted one (matches hub.ts ordering). */
  next?: { provider?: string; model?: string; reasoningEffort?: string } | null
  lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null
}

/** `contextPressure` projection fields this UI reads (dsh-token-meter). */
export interface ContextPressureView {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface ModelRoute {
  provider: string
  model: string
}

/**
 * Parse a `${provider}/${model}` option value. Model ids themselves may carry
 * slashes (e.g. `openrouter/anthropic/claude-x`), so only the FIRST separator
 * belongs to the route — `String.split('/')` silently truncates those ids.
 */
export function parseRoute(value: string): { provider: string; model: string } {
  const slash = value.indexOf('/')
  if (slash < 0) return { provider: value, model: '' }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/** Effective route for the session, or undefined until one is recorded. */
export function useModelRoute(useProjection: UseProjection | undefined): ModelRoute | undefined {
  const selection = useProjection?.('modelSelection') as ModelSelectionView | undefined
  const route = selection?.next ?? selection?.lastUsed
  const provider = route?.provider
  const model = route?.model
  // Stable identity: effects depending on `route` must not re-run on every
  // render just because the projection hook returned a fresh object.
  return useMemo(
    () => (provider === undefined || model === undefined ? undefined : { provider, model }),
    [provider, model],
  )
}
