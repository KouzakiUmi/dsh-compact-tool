/**
 * Shared UI-estimate inputs for the budget preview: the assumed per-request
 * output reserve is not a persisted config value (the engine derives it per
 * request), but every entry point that draws a trigger marker must use the
 * SAME estimate or the settings page, dialog and dock would each show the
 * trigger at a different position for the same policy.
 */

import { createStore } from './store.js'

export const DEFAULT_RESERVE_TOKENS = 8192

const store = createStore<number>(DEFAULT_RESERVE_TOKENS)

/** Current shared reserve estimate (tokens). */
export function reserveTokens(): number {
  return store.getSnapshot()
}

/** Shared reserve store handle (subscribe/getSnapshot for useSyncExternalStore). */
export function reserveStore(): { subscribe: (listener: () => void) => () => void; getSnapshot: () => number } {
  return store
}

/** Update the shared reserve estimate; all entries re-render together. */
export function setReserveTokens(value: number): void {
  store.set(value)
}
