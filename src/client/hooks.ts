/** Remote data hooks + save plumbing shared by the settings page and dialog. */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
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

/** Call a remote method and expose its value through an AsyncState. */
export function useRemote<T>(call: () => Promise<RemoteResult<T>>, deps: readonly unknown[]): {
  state: AsyncState<T>
  reload(): void
} {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  const [seq, setSeq] = useState(0)
  const callRef = useRef(call)
  callRef.current = call
  const prevDeps = useRef<readonly unknown[] | null>(null)
  const hasValue = useRef(false)
  useEffect(() => {
    let live = true
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
    void Promise.resolve().then(() => callRef.current())
      .then((result) => {
        if (!live) return
        if (result.ok) {
          hasValue.current = true
          setState({ status: 'ready', value: result.value })
        } else if (!(soft && hasValue.current)) {
          setState({ status: 'error', error: errorOf(result) ?? { code: 'unknown', message: 'unknown' } })
        }
        // Soft-refetch failure keeps the previous value: it is still the
        // freshest truth we have, and write errors surface via SaveStatus.
      }, (error: unknown) => {
        if (!live) return
        if (!(soft && hasValue.current)) {
          setState({ status: 'error', error: { code: 'throw', message: error instanceof Error ? error.message : String(error) } })
        }
      })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, ...deps])
  return { state, reload: useCallback(() => { setSeq(n => n + 1) }, []) }
}

export interface SaveState {
  saving: boolean
  error: string | null
  savedAt: number | null
  /** Mark one wire write as in-flight; pairs with the next `mutate`. */
  begin(): void
  /** Settle one write's status ONLY. The optimistic draft is the source of
   *  truth and is never overwritten by a response snapshot. */
  mutate(err?: string): void
  /** Replace the draft with server truth (failure rollback / explicit refresh). */
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
    setConfig: setConfigState,
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
  (key: string, patch: Record<string, unknown>, save: (patch: Record<string, unknown>) => Promise<void>): void
  /** Drop every timer that has not fired yet whose key starts with `prefix`. */
  cancelByPrefix(prefix: string): void
  /** Append a task to the same serial chain used by flushed timers. */
  enqueue(task: () => void | Promise<void>): Promise<void>
}

/**
 * Merge pending edits to one policy into a single atomic patch.
 *
 * Switching policies flushes the pending patch so dependent edits to global
 * and model settings reach the host in the order the user made them. Every
 * flushed task and removal uses the same serial chain. `cancelByPrefix` drops
 * an unsent patch that would otherwise recreate the removed model policy.
 *
 * Unmount FLUSHES pending tasks onto the chain instead of dropping them: host
 * config writes remount slot fibers, and a cancelled timer would silently lose
 * the user's optimistic edit. setState inside a flushed task no-ops on the
 * dead fiber; only the wire call matters, and it is idempotent (partial-write
 * upsert).
 */
export function useDebouncedWriter(delayMs = 600): DebouncedWriter {
  const pending = useRef<{
    key: string
    timer: ReturnType<typeof setTimeout>
    patch: Record<string, unknown>
    task: () => Promise<void>
  } | null>(null)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const run = useCallback((task: () => void | Promise<void>): Promise<void> => {
    // A task owns its own error handling; the catch only keeps the chain alive
    // after an unexpected throw so later writes are not stuck behind it.
    const next = chain.current.then(() => Promise.resolve(task())).catch(() => { /* keep chain alive */ })
    chain.current = next
    return next as Promise<void>
  }, [])
  const takePending = useCallback(() => {
    const entry = pending.current
    pending.current = null
    if (entry !== null) clearTimeout(entry.timer)
    return entry
  }, [])
  const flush = useCallback(() => {
    const entry = takePending()
    if (entry !== null) void run(entry.task)
  }, [run, takePending])
  const write = useCallback((key: string, patch: Record<string, unknown>, save: (patch: Record<string, unknown>) => Promise<void>) => {
    if (pending.current?.key !== key) flush()
    const existing = takePending()
    const merged = { ...existing?.patch, ...patch }
    pending.current = {
      key,
      patch: merged,
      task: () => save(merged),
      timer: setTimeout(flush, delayMs),
    }
  }, [delayMs, flush, takePending])
  const cancelByPrefix = useCallback((prefix: string) => {
    if (pending.current?.key.startsWith(prefix)) takePending()
  }, [takePending])
  const enqueue = useCallback((task: () => void | Promise<void>) => run(task), [run])
  useEffect(() => flush, [flush])
  const writer = write as DebouncedWriter
  writer.cancelByPrefix = cancelByPrefix
  writer.enqueue = enqueue
  return writer
}
