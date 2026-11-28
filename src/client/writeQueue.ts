/**
 * Module-level write coordination shared by every fiber and every entry point
 * (dock popover, policy dialog, settings page — and multiple sessions' docks).
 *
 * Why module level: each `useDebouncedWriter` hook instance used to own a
 * private chain and timer. A removal issued from one entry point therefore
 * could not cancel a pending debounced field write scheduled in another, and
 * the late upsert silently resurrected the just-deleted override row. One
 * canonical scope per write target (`global` or `pol:<provider>/<model>`)
 * means all entries share the same serial chain, the same debounce timer and
 * the same cancellation, so wire order always matches user-intent order.
 *
 * Convergence model: optimistic copies are never overwritten while a scope is
 * dirty (a debounced write pending or a chain task in flight). Dirtiness
 * guarantees a future convergence event — the in-flight write either succeeds
 * (and bumps the config revision, re-arming reseeds everywhere) or fails (and
 * its failure path re-arms a reseed) — so skipping an overwrite while dirty
 * cannot leave the UI permanently stale.
 */

/** Canonical scope for the global policy row. */
export const GLOBAL_SCOPE = 'global'

/** Canonical scope for one exact provider/model override row. */
export function policyScope(provider: string, model: string): string {
  return `pol:${provider}/${model}`
}

/**
 * The write contract one submitter contributes. The queue treats these
 * hooks as opaque: it never inspects what the remote call is.
 *
 * - `commit` performs exactly one remote write of the merged patch. When
 *   several submitters' debounced edits merge into one write, only the LAST
 *   submitter's `commit` runs (per-scope commits are identical operations on
 *   the merged patch; the freshest closure also carries the freshest remote
 *   references).
 * - `begin`/`settle` are per-submittee lifecycle hooks. A merged write fires
 *   EVERY submitter's `begin` (in submission order) when it starts and EVERY
 *   `settle` (in order) with the shared outcome — a submitter whose edit was
 *   subsumed must still settle its own saving/error state, otherwise the
 *   earlier entry stays stuck in "saving" on success or keeps a rolled-forward
 *   optimistic edit on failure.
 */
export interface WriteHooks {
  commit: (patch: Record<string, unknown>) => Promise<void>
  begin?: () => void
  settle?: (err: string | undefined) => void
}

interface PendingWrite {
  patch: Record<string, unknown>
  commit: WriteHooks['commit']
  begins: Array<() => void>
  settles: Array<(err: string | undefined) => void>
  timer: ReturnType<typeof setTimeout>
}

interface ScopeState {
  pending: PendingWrite | null
  chain: Promise<unknown>
  /** Chain tasks enqueued but not yet settled (including the running one). */
  active: number
  /** Optimistic-mutation epoch: every scheduled/enqueued write bumps it. */
  gen: number
}

const scopes = new Map<string, ScopeState>()
const dirtyListeners = new Set<() => void>()
let dirtyDepth = 0

function stateOf(scope: string): ScopeState {
  let state = scopes.get(scope)
  if (state === undefined) {
    state = { pending: null, chain: Promise.resolve(), active: 0, gen: 0 }
    scopes.set(scope, state)
  }
  return state
}

/**
 * Dirtiness changes must be OBSERVABLE: a reseed skipped because the scope was
 * dirty has no other re-trigger — the convergence proof depends on effects
 * re-running when the last write drains. Subscribers may read either the
 * global depth (monolithic drafts) or one scope's flag (`scopeDirtySnapshot`),
 * so listeners fire on EVERY depth change, not just zero crossings; per-scope
 * snapshots are booleans, so a scope settles even while another stays dirty.
 * Mutations update depth first and notify once at the end — a transfer
 * (pending → chain) is net-zero and never emits a phantom "idle" transition.
 */
function notifyDirty(): void {
  for (const listener of [...dirtyListeners]) listener()
}
function bumpDepth(delta: number): void {
  dirtyDepth += delta
}

/** useSyncExternalStore adapter: re-renders when dirtiness flips. */
export function subscribeDirty(listener: () => void): () => void {
  dirtyListeners.add(listener)
  return () => { dirtyListeners.delete(listener) }
}

/** Snapshot for subscribeDirty: global dirty depth. */
export function dirtyDepthSnapshot(): number {
  return dirtyDepth
}

/**
 * Per-scope boolean snapshot for subscribeDirty. Reading `scopeDirty` inside
 * an effect body is not reactive on its own; pairing this snapshot with
 * useSyncExternalStore re-renders exactly when THIS scope settles, even while
 * other scopes are still dirty (a global depth subscription would not).
 */
export function scopeDirtySnapshot(scope: string): boolean {
  return scopeDirty(scope)
}

/** Current optimistic-mutation epoch of a scope (monotonic). */
export function writeGen(scope: string): number {
  return stateOf(scope).gen
}

/**
 * True while the scope carries user edits the server has not confirmed: a
 * debounced write waiting on its timer, or a chain task still in flight.
 * Overwriting optimistic state in this window is what produced the reset
 * bounce / wiped-edit races, so every reseed/rollback checks this first.
 */
export function scopeDirty(scope: string): boolean {
  const state = stateOf(scope)
  return state.pending !== null || state.active > 0
}

/** True while ANY scope is dirty — the guard for monolithic-draft reseeds. */
export function anyScopeDirty(): boolean {
  for (const state of scopes.values()) {
    if (state.pending !== null || state.active > 0) return true
  }
  return false
}

function chainPush(state: ScopeState, task: () => void | Promise<void>, transfer = false): Promise<void> {
  state.active += 1
  // `transfer` means the dirtiness unit arrives from the pending slot instead
  // of being newly created: depth is unchanged, so nothing notifies here.
  if (!transfer) {
    bumpDepth(1)
    notifyDirty()
  }
  // A task owns its own error handling; the catch only keeps the chain alive
  // after an unexpected throw so later writes are not stuck behind it.
  const next = state.chain
    .then(() => Promise.resolve().then(task))
    .catch(() => { /* keep chain alive */ })
    .then(() => {
      state.active -= 1
      bumpDepth(-1)
      notifyDirty()
    })
  state.chain = next
  return next as Promise<void>
}

/**
 * Append a task to the scope's serial chain. The task is an optimistic
 * mutation (create/remove override), so the scope epoch bumps synchronously —
 * callers capture `writeGen(scope)` right after this call to detect later
 * edits from inside the task's response handler.
 */
export function enqueueWrite(scope: string, task: () => void | Promise<void>): Promise<void> {
  const state = stateOf(scope)
  state.gen += 1
  // Causal ordering: any debounced field edit still waiting on its timer is
  // OLDER user intent than this chain operation, so it must land first.
  // Flushing (not cancelling) is what makes reset-then-recreate converge to
  // an EMPTY row: the reset write removes the last field (host drops the
  // row), the removal write becomes a no-op, and the create write rebuilds
  // the row empty. Cancelling used to silently drop the reset — the row then
  // survived with the pre-reset field values and the UI converged back to
  // them, erasing the user's edit.
  firePending(scope)
  return chainPush(state, task)
}

/**
 * Debounce one optimistic field edit into the scope's pending patch. Same-scope
 * edits merge key-by-key (later wins) so dependent writes (retain exclusivity,
 * summarization pairs) stay atomic. The epoch bumps per edit; the write itself
 * fires `delayMs` after the last edit, serialized on the scope chain.
 */
export function scheduleWrite(
  scope: string,
  patch: Record<string, unknown>,
  hooks: WriteHooks,
  delayMs: number,
): void {
  const state = stateOf(scope)
  state.gen += 1
  const existing = state.pending
  const isNew = existing === null
  const mergedPatch = isNew ? patch : { ...existing!.patch, ...patch }
  // Composition rules for a merge: the PATCH unions key-by-key (later wins,
  // keeping dependent writes atomic); the COMMIT is the latest submitter's
  // (one remote write for the union); the LIFECYCLE hooks accumulate so
  // every submitter pair-settles exactly once.
  const begins = isNew ? [] : [...existing!.begins]
  const settles = isNew ? [] : [...existing!.settles]
  if (hooks.begin !== undefined) begins.push(hooks.begin)
  if (hooks.settle !== undefined) settles.push(hooks.settle)
  if (!isNew) clearTimeout(existing!.timer)
  state.pending = {
    patch: mergedPatch,
    commit: hooks.commit,
    begins,
    settles,
    timer: setTimeout(() => { firePending(scope) }, delayMs),
  }
  // Notify AFTER the state is fully installed: a subscriber reading the
  // snapshot synchronously must already see the pending unit.
  if (isNew) {
    bumpDepth(1)
    notifyDirty()
  }
}

/** Fire the scope's pending debounced write onto the chain immediately. */
export function flushWrite(scope: string): void {
  firePending(scope)
}

function firePending(scope: string): void {
  const state = stateOf(scope)
  const pending = state.pending
  if (pending === null) return
  state.pending = null
  clearTimeout(pending.timer)
  // Pending transfers onto the chain as one atomic handoff: the depth is
  // unchanged end-to-end, so no phantom idle transition reaches subscribers.
  // The task's settle decrement retires the unit when the write lands.
  void chainPush(state, async () => {
    for (const begin of pending.begins) {
      try { begin() } catch { /* lifecycle hooks must not break the chain */ }
    }
    let err: string | undefined
    try {
      await pending.commit(pending.patch)
    } catch (error) {
      err = error instanceof Error ? error.message : String(error)
    }
    for (const settle of pending.settles) {
      try { settle(err) } catch { /* lifecycle hooks must not break the chain */ }
    }
  }, true)
}

/**
 * Drop the scope's pending debounced write without firing it. Only removals
 * may do this (the user asked for the row to go away; a late field upsert
 * would recreate it). Because the scope is shared module-wide, this cancels
 * pending writes no matter which entry point scheduled them.
 */
export function cancelWrite(scope: string): void {
  const state = stateOf(scope)
  if (state.pending !== null) {
    clearTimeout(state.pending.timer)
    state.pending = null
    bumpDepth(-1)
    notifyDirty()
  }
}

/** Test hook: reset all coordination state. NOT for production use. */
export function resetWriteQueueForTests(): void {
  for (const state of scopes.values()) {
    if (state.pending !== null) clearTimeout(state.pending.timer)
  }
  scopes.clear()
  dirtyDepth = 0
  dirtyListeners.clear()
}
