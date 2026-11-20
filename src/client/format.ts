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

/** Bounds for edits to one scope, including the model policies it affects. */
export function ratioSliderBounds(global: CompactConfig, policy?: PolicyFields) {
  const threshold = policy?.thresholdRatio ?? global.thresholdRatio ?? DEFAULTS.thresholdRatio
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
