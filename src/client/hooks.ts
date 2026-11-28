/** Remote data hooks + save plumbing shared by the settings page and dialog. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { dirtyDepthSnapshot, enqueueWrite, flushWrite, scheduleWrite, scopeDirtySnapshot, subscribeDirty, type WriteHooks } from './writeQueue.js'
import type { RemoteResult } from './remote-types.js'
import { remoteHandle } from './remote.js'
import type { CompactConfig } from '../shared.js'

export type Translator = (key: string, vars?: Record<string, unknown>) => string

/** Upper bound for one config write. A stalled host call (file-lock contention
 *  with an active compaction, a reactivating fiber) must not freeze the serial
 *  chain or the saving indicator forever. The host write may still land later
 *  (idempotent); the client treats a timeout as failure and re-seeds truth. */
export const WRITE_TIMEOUT_MS = 30_000

/** Race a promise against a timeout so a hung remote call always settles. */
export function withTimeout<T>(promise: Promise<T>, ms: number = WRITE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`config write timed out after ${ms}ms`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export interface RemoteErrorInfo {
  code: string
  message: string
}

export function errorOf(result: RemoteResult<unknown> | { ok: boolean; error?: unknown }): RemoteErrorInfo | null {
  if (result.ok) return null
  const error = (result as { error?: { code?: string; message?: string } }).error
  return {
    code: typeof error?.code === 'string' ? error.code : 'unknown',
    message: typeof error?.message === 'string' ? error.message : 'unknown error',
  }
}

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: RemoteErrorInfo }
  | { status: 'ready'; value: T }

/** Retry delays (ms) for soft-refetch failures: the failure keeps the stale
 *  value invisible to the user, so a quiet retry is the only convergence path. */
const SOFT_RETRY_DELAYS = [1500, 3000, 6000]

/** Call a remote method and expose its value through an AsyncState. */
export function useRemote<T>(call: () => Promise<RemoteResult<T>>, deps: readonly unknown[]): {
  state: AsyncState<T>
  reload(): void
  /** Identity of the chain whose attempt last CONCLUDED — success, hard
   *  failure (no stale value), or soft-retry exhaustion. Every chain gets a
   *  unique increasing number assigned inside the effect, so a consumer that
   *  captured `chainEpoch` before calling `reload()` can tell apart:
   *  resolution of the chain it fired (concludedChain > captured), resolution
   *  of an older chain (concludedChain ≤ captured — must NOT be applied), and
   *  "nothing concluded yet". Counters alone cannot do this: the resolution
   *  of the chain that was in flight before the reload moves the same counter
   *  as the re-fired chain, and retry exhaustion produces no new state object
   *  at all, so neither identity nor counters are sufficient attribution. */
  concludedChain: number
  /** Chain number of the currently RUNNING effect iteration (monotonic,
   *  increasing by one per effect run). Read it BEFORE calling `reload()`:
   *  the resolution is attributable to the re-fired chain exactly when
   *  `concludedChain` grows beyond this captured value. */
  chainEpoch: number
  /** Identity of the chain whose attempt last RESOLVED SUCCESSFULLY.
   *  Distinct from `concludedChain`: hard failures and soft-retry exhaustion
   *  conclude a chain WITHOUT producing a usable resolution, yet they still
   *  advance `concludedChain`. A consumer deciding whether `state` carries
   *  the resolution of ITS re-fired chain must compare `resolvedChain`,
   *  never `concludedChain` — otherwise a failed chain's conclusion makes
   *  the consumer accept the stale pre-failure value as the new truth. */
  resolvedChain: number
} {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  const [seq, setSeq] = useState(0)
  const chainRef = useRef(0)
  const [concludedChain, setConcludedChain] = useState(0)
  const [resolvedChain, setResolvedChain] = useState(0)
  const callRef = useRef(call)
  callRef.current = call
  const prevDeps = useRef<readonly unknown[] | null>(null)
  const hasValue = useRef(false)
  useEffect(() => {
    let live = true
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    // One chain identity per effect iteration, assigned before any async work
    // starts. Retry rounds inside one chain keep the identity — the chain
    // concludes only on success, hard failure, or exhaustion.
    chainRef.current += 1
    const chain = chainRef.current
    const conclude = (): void => { setConcludedChain(n => Math.max(n, chain)) }
    // Stale-while-revalidate: a rerun whose deps did not change (manual
    // `reload`, or a re-resolve after a config write) keeps the last value
    // visible instead of flashing every consumer back through `loading`.
    // Only a real dep change (new route, new session) hard-resets.
    const soft = prevDeps.current !== null
      && prevDeps.current.length === deps.length
      && deps.every((dep, i) => dep === prevDeps.current?.[i])
    prevDeps.current = deps
    if (!(soft && hasValue.current)) setState({ status: 'loading' })
    // Promise.resolve().then converts a synchronous remoteHandle() throw
    // (remote namespace not mounted yet) into the catchable error branch
    // instead of crashing the effect.
    const attempt = (retriesLeft: number): void => {
      void Promise.resolve().then(() => callRef.current())
        .then((result) => {
          if (!live) return
          if (result.ok) {
            hasValue.current = true
            setState({ status: 'ready', value: result.value })
            setResolvedChain(n => Math.max(n, chain))
            conclude()
          } else if (!(soft && hasValue.current)) {
            setState({ status: 'error', error: errorOf(result) ?? { code: 'unknown', message: 'unknown' } })
            conclude()
          } else {
            retry(retriesLeft)
          }
          // Soft-refetch failure keeps the previous value: it is still the
          // freshest truth we have, and write errors surface via SaveStatus.
        }, (error: unknown) => {
          if (!live) return
          if (!(soft && hasValue.current)) {
            setState({ status: 'error', error: { code: 'throw', message: error instanceof Error ? error.message : String(error) } })
            conclude()
          } else {
            retry(retriesLeft)
          }
        })
    }
    // A failed soft refetch used to leave consumers permanently stale (nothing
    // re-ran this effect). Retry quietly a few times; success or a hard dep
    // change ends the sequence. Exhaustion CONCLUDES the chain too, otherwise
    // a consumer awaiting this resolution waits forever.
    const retry = (retriesLeft: number): void => {
      if (!live) return
      if (retriesLeft <= 0) {
        conclude()
        return
      }
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (live) attempt(retriesLeft - 1)
      }, SOFT_RETRY_DELAYS[SOFT_RETRY_DELAYS.length - retriesLeft] ?? 6000)
    }
    attempt(SOFT_RETRY_DELAYS.length)
    return () => {
      live = false
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, ...deps])
  return {
    state,
    reload: useCallback(() => { setSeq(n => n + 1) }, []),
    concludedChain,
    resolvedChain,
    chainEpoch: chainRef.current,
  }
}

export interface SaveState {
  saving: boolean
  error: string | null
  savedAt: number | null
  /** Monotonic optimistic-edit epoch: every `setConfig` (user edit) bumps it.
   *  Reseeding does NOT — it is server truth, not an edit. Failure paths use
   *  this to detect edits that happened after a write was sent. */
  epoch(): number
  /** Mark one wire write as in-flight; pairs with the next `mutate`. */
  begin(): void
  /** Settle one write's status ONLY. The optimistic draft is the source of
   *  truth and is never overwritten by a response snapshot. */
  mutate(err?: string): void
  /** Replace the draft with server truth (failure rollback / explicit refresh).
   *  Does not bump the epoch. */
  reseed(config: CompactConfig | null): void
  /** Functional updater so concurrent optimistic edits compose (no stale closure). */
  setConfig: Dispatch<SetStateAction<CompactConfig | null>>
  config: CompactConfig | null
}

/**
 * Local editable copy of the compaction config: mutations update the draft
 * immediately (UI stays responsive) and the caller decides when each wire
 * write lands (per-control debounce). `begin`/`mutate` track the in-flight
 * count so `saving` is accurate when several debounced writes overlap.
 */
export function useConfigDraft(initial: CompactConfig | null): SaveState {
  const [config, setConfigState] = useState<CompactConfig | null>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const pending = useRef(0)
  const seeded = useRef(false)
  const editEpoch = useRef(0)
  const setConfig = useCallback<Dispatch<SetStateAction<CompactConfig | null>>>((action) => {
    // Every mutation through this channel is a user edit; bumping the epoch
    // here keeps failure paths honest even when they capture it before the
    // React state actually commits.
    editEpoch.current += 1
    setConfigState(action)
  }, [])
  // Seed the draft once, when the first server snapshot arrives. Re-seeding on
  // every `initial` identity change (a `describe` soft reload, a fiber remount)
  // would roll back optimistic edits with a possibly stale server snapshot.
  useEffect(() => {
    if (initial !== null && !seeded.current) {
      seeded.current = true
      setConfigState(initial)
    }
  }, [initial])
  return {
    config,
    saving,
    error,
    savedAt,
    epoch: useCallback(() => editEpoch.current, []),
    setConfig,
    begin() {
      pending.current += 1
      setSaving(true)
    },
    mutate(err) {
      // Confirmation only — never touch the draft here. Merging a response
      // snapshot back (even local-wins) resurrects optimistically-deleted keys
      // from the server row and clobbers other fields' pending edits; that was
      // the reset bounce / slider jump. On success the optimistic value already
      // equals what we wrote. Failure rollback uses `reseed` with fresh truth.
      setError(err ?? null)
      pending.current = Math.max(0, pending.current - 1)
      setSaving(pending.current > 0)
      if (err === undefined || err === null) setSavedAt(Date.now())
    },
    reseed(config) {
      setConfigState(config)
    },
  }
}

export interface DebouncedWriter {
  /** Schedule a debounced field write into the canonical write scope
   *  (`GLOBAL_SCOPE` or `policyScope(p, m)` from writeQueue.ts). The scope is
   *  module-wide: every entry point shares one timer, one merge patch and one
   *  serial chain per target, so wire order always matches user intent.
   *  `hooks.commit` performs the single merged remote write; `begin`/`settle`
   *  are per-caller lifecycle hooks that always pair-fire exactly once, even
   *  when several callers' edits merge into one wire write. */
  (scope: string, patch: Record<string, unknown>, hooks: WriteHooks): void
  /** Append a task to the scope's serial chain (create/remove override). */
  enqueueWrite(scope: string, task: () => void | Promise<void>): Promise<void>
}

/**
 * Per-fiber facade over the module-level write queue (writeQueue.ts).
 *
 * The queue itself never dies with a fiber: host config writes remount slot
 * fibers, and the debounce timer must survive so the optimistic edit still
 * reaches the host. Unmount FLUSHES this fiber's scopes onto the chain instead
 * of waiting out the debounce window — same end effect as before, without
 * tying wire timing to fiber lifetime.
 */
export function useDebouncedWriter(delayMs = 600): DebouncedWriter {
  const writtenScopes = useRef<Set<string> | null>(null)
  const noteScope = useCallback((scope: string): void => {
    if (writtenScopes.current === null) writtenScopes.current = new Set()
    writtenScopes.current.add(scope)
  }, [])
  const write = useCallback((scope: string, patch: Record<string, unknown>, hooks: WriteHooks) => {
    noteScope(scope)
    scheduleWrite(scope, patch, hooks, delayMs)
  }, [delayMs, noteScope])
  const enqueue = useCallback((scope: string, task: () => void | Promise<void>) => {
    noteScope(scope)
    return enqueueWrite(scope, task)
  }, [noteScope])
  useEffect(() => () => {
    // Remount-safe flush: only flush scopes THIS fiber actually wrote; other
    // entries' pending edits keep their own debounce cadence.
    for (const scope of writtenScopes.current ?? []) flushWrite(scope)
  }, [])
  const writer = write as DebouncedWriter
  writer.enqueueWrite = enqueue
  return writer
}

/**
 * Re-render signal for write-queue dirtiness transitions. Without a scope the
 * subscription tracks GLOBAL depth (monolithic drafts like the settings page
 * must wait for every scope); with one it tracks exactly that scope — an
 * effect guarding on `scopeDirty(scope)` must NOT depend on other scopes
 * settling, otherwise a long-lived dirty scope (another entry's timer still
 * running) stalls this entry's reseed forever.
 */
export function useWriteDirtiness(scope?: string): boolean {
  const snapshot = useCallback(() => (scope === undefined
    ? dirtyDepthSnapshot() > 0
    : scopeDirtySnapshot(scope)), [scope])
  return useSyncExternalStore(subscribeDirty, snapshot)
}
