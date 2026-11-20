import type { CatalogResult } from '../shared.js'

/** One configured summarization route the live catalog no longer advertises. */
export interface SummarizationRouteIssue {
  readonly provider: string
  readonly model: string
  /** `provider-missing` is definitive; `model-missing` may also be a transient catalog outage. */
  readonly kind: 'provider-missing' | 'model-missing'
}

/**
 * Detect a dead explicit summarization route. Returns null for the empty
 * "use session model" pair, when the catalog is not loaded (unknown ≠ dead),
 * or when the route is still advertised. Advisory only — the UI must not
 * overclaim a `model-missing` result as permanent, because `catalog()` maps a
 * provider's failed model listing to an empty array.
 */
export function summarizationIssue(
  fields: {
    readonly summarizationProvider?: string | undefined
    readonly summarizationModel?: string | undefined
  },
  catalog: CatalogResult | null,
): SummarizationRouteIssue | null {
  if (catalog === null) return null
  const provider = fields.summarizationProvider ?? ''
  const model = fields.summarizationModel ?? ''
  // Empty pair means "same model as the session" — nothing to validate.
  if (provider === '') return null
  if (!catalog.providers.some(p => p.id === provider)) {
    return { provider, model, kind: 'provider-missing' }
  }
  if (model !== '' && !(catalog.models[provider] ?? []).some(m => m.model === model)) {
    return { provider, model, kind: 'model-missing' }
  }
  return null
}
