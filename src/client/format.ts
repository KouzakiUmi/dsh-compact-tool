/** Token-count formatting and math shared by the bar and sliders. */

import { DEFAULTS, resolveRetention, type CompactConfig, type PolicyFields } from '../shared.js'

export function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) {
    const scaled = value / 1_000
    return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}k`
  }
  const scaled = value / 1_000_000
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}M`
}

/**
 * Mirror of compaction-basic resolveCompactSpec: the trigger is the lower of
 * the ratio share of the window and what remains after the output reserve and
 * headroom are deducted.
 */
export function thresholdTokens(
  contextWindow: number,
  thresholdRatio: number,
  headroomTokens: number,
  reserveTokens: number,
): number {
  const messageBudget = contextWindow - reserveTokens
  const pressureBudget = messageBudget - headroomTokens
  if (pressureBudget <= 0) return 0
  return Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudget))
}

/** Mirror of the retain budget: ratio of the message budget, or the fixed row. */
export function retainTokens(
  contextWindow: number,
  reserveTokens: number,
  retainRatio: number,
  retainTokensFixed: number | undefined,
): number {
  if (retainTokensFixed !== undefined) return retainTokensFixed
  const messageBudget = contextWindow - reserveTokens
  if (messageBudget <= 0) return 0
  return Math.floor(messageBudget * retainRatio)
}

/**
 * Mirrors the engine's runtime invariant for the state a CLEAR would leave
 * behind: `resolveCompactSpec` throws when the resolved retention reaches the
 * trigger (`retained >= trigger`), rejecting the whole configuration at
 * runtime. Clearing an override is statically legal — inheritance itself is
 * always valid — but when the window is known the inherited values can be
 * evaluated exactly, and if they already violate the invariant the clear only
 * moves the route from a valid override into a budget the engine refuses.
 * All four budget keys are gated — `thresholdRatio`/`headroomTokens` move
 * the trigger, `retainRatio`/`retainTokens` move the retention — because
 * clearing any of them shifts the resolved budget without the protection
 * the slider bounds give a deliberate drag. The remaining keys
 * (summarization pair, maxTokens, retry counts) never participate in the
 * invariant. The cleared key falls to `base`; every other key keeps the
 * row's own override.
 */
export function clearViolatesRuntimeInvariant(
  contextWindow: number | undefined,
  reserveTokens: number,
  key: 'thresholdRatio' | 'headroomTokens' | 'retainRatio' | 'retainTokens',
  row: PolicyFields,
  base: PolicyFields,
): boolean {
  if (contextWindow === undefined || contextWindow <= 0) return false
  const pick = <K extends keyof PolicyFields>(k: K): PolicyFields[K] | undefined =>
    (k === key ? undefined : row[k]) ?? base[k]
  const thresholdRatio = pick('thresholdRatio') ?? DEFAULTS.thresholdRatio
  const headroom = pick('headroomTokens') ?? DEFAULTS.headroomTokens
  // The retention must resolve in the engine's own order — the row's ratio
  // outranks the global FIXED retention — so reuse resolveRetention against
  // the post-clear row rather than merging keys by hand: a hand-merged
  // object would let the global retainTokens shadow the row's retainRatio.
  const postClearRow: PolicyFields = { ...row }
  if (key === 'retainTokens') delete postClearRow.retainTokens
  if (key === 'retainRatio') delete postClearRow.retainRatio
  const retention = resolveRetention(base, postClearRow)
  const retained = retainTokens(contextWindow, reserveTokens, retention.retainRatio ?? DEFAULTS.retainRatio, retention.retainTokens)
  const trigger = thresholdTokens(contextWindow, thresholdRatio, headroom, reserveTokens)
  return retained >= trigger
}

/** Bounds for edits to one scope, including the model policies it affects. */
export function ratioSliderBounds(global: CompactConfig, policy?: PolicyFields) {  const threshold = policy?.thresholdRatio ?? global.thresholdRatio ?? DEFAULTS.thresholdRatio
  const retention = resolveRetention(global, policy).retainRatio
  let highestRetention = retention ?? 0
  let lowestThreshold = threshold
  if (policy === undefined) {
    for (const model of global.modelPolicies ?? []) {
      if (model.thresholdRatio === undefined) {
        highestRetention = Math.max(highestRetention, resolveRetention(global, model).retainRatio ?? 0)
      }
      if (model.retainRatio === undefined && model.retainTokens === undefined) {
        lowestThreshold = Math.min(lowestThreshold, model.thresholdRatio ?? threshold)
      }
    }
  }

  const retentionPercent = Math.round(highestRetention * 100)
  const thresholdPercent = Math.round(lowestThreshold * 100)
  const nextThreshold = (retentionPercent + Number(retentionPercent / 100 <= highestRetention)) / 100
  const previousRetention = (thresholdPercent - Number(thresholdPercent / 100 >= lowestThreshold)) / 100
  const thresholdMin = Math.max(Math.min(0.4, threshold), Math.min(threshold, nextThreshold))
  const retainMax = Math.max(
    Math.min(0.6, previousRetention > 0 ? previousRetention : lowestThreshold / 2),
    retention !== undefined && retention < lowestThreshold ? retention : 0,
  )
  return {
    thresholdMin,
    thresholdMax: Math.max(0.95, threshold),
    retainMin: Math.min(0.02, retainMax),
    retainMax,
  }
}

/**
 * Runtime-token-domain guardrails for the fixed-token sliders.
 *
 * `resolveCompactSpec` enforces at RUNTIME — against the routed window and the
 * per-request output reserve, neither fully known at config time — that
 * `retainTokens(resolved) < thresholdTokens` and that the pressure budget
 * (window − reserve − headroom) stays positive. A violation does not just warn:
 * the model-switch path rejects the switch outright. The sliders cannot prove
 * the invariant (reserve is an estimate, the window differs per model), but
 * when a window IS known they must not offer values already past the line.
 * Everything is snapped to the 1024 grid the sliders step on.
 *
 * `retention` is the RESOLVED retention of the scope being edited
 * (`resolveRetention` output, possibly a fixed-token row — its own slider is
 * not capped against itself). The engine derives ratio-mode retain from the
 * MESSAGE budget (`window − reserve`, headroom NOT deducted); mirroring that
 * matters: passing 0 in ratio mode used to let the headroom slider offer
 * values that leave fewer trigger tokens than the ratio retention keeps —
 * a config the engine rejects at model-switch time. A negative cap means no
 * legal value exists; callers must collapse the control (disable), never
 * silently raise it to the static minimum.
 */
export function tokenSliderBounds(
  contextWindow: number | undefined,
  reserveTokens: number,
  thresholdRatio: number,
  headroomTokens: number,
  retention: { retainRatio?: number | undefined; retainTokens?: number | undefined },
): { retainTokensMax: number | undefined; headroomTokensMax: number | undefined } {
  if (contextWindow === undefined || contextWindow <= 0) {
    return { retainTokensMax: undefined, headroomTokensMax: undefined }
  }
  const snapDown = (v: number): number => Math.floor(v / 1024) * 1024
  // retainTokens must stay strictly below the trigger; grid values equal to the
  // trigger already violate it, so cap one grid step below.
  const trigger = thresholdTokens(contextWindow, thresholdRatio, headroomTokens, reserveTokens)
  const retainCap = snapDown(trigger - 1)
  // headroomTokens must leave the pressure budget above the resolved retention.
  const messageBudget = contextWindow - reserveTokens
  const retainEstimate = retention.retainTokens !== undefined
    ? retention.retainTokens
    : Math.floor(Math.max(messageBudget, 0) * (retention.retainRatio ?? 0))
  const headroomCap = snapDown(contextWindow - reserveTokens - retainEstimate - 1)
  return {
    retainTokensMax: retainCap,
    headroomTokensMax: headroomCap,
  }
}
