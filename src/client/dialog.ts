/**
 * Cross-scope channel between session-scoped entry components (dock button,
 * model-menu gear) and the root-scoped `shell.overlay` dialog host. Session
 * seats cannot mount a root dialog directly, so an entry writes a
 * DialogRequest here and PolicyDialogHost (overlay seat) reacts to it.
 */

import { useSyncExternalStore } from 'react'
import { createStore } from './store.js'
import type { UseProjection } from './sessionKit.js'

export interface DialogRequest {
  sessionId: string
  provider: string
  model: string
  useProjection: UseProjection
}

export const dialogStore = createStore<DialogRequest | null>(null)

/** Open the per-model policy dialog for one session route. */
export function openDialog(request: DialogRequest): void {
  dialogStore.set(request)
}

export function closeDialog(): void {
  dialogStore.set(null)
}

/** Root-scope bridge: mounts the policy dialog while a request is pending. */
export function useDialogRequest(): DialogRequest | null {
  return useSyncExternalStore(dialogStore.subscribe, dialogStore.getSnapshot)
}

/* ------------------------------------------------------------------ */
/* Dock popover focus channel                                          */
/* ------------------------------------------------------------------ */

/**
 * Session-to-session channel: the model-menu gear entry cannot open the dock
 * meter's popover itself (both are session fibers, not root), so it drops the
 * target sessionId here. DockEntry subscribes and opens its popover. One-shot
 * semantics: the entry deletes its id after reacting.
 */
const popRequests = createStore<ReadonlySet<string>>(new Set())

export function requestDockPopover(sessionId: string): void {
  const next = new Set(popRequests.getSnapshot())
  next.add(sessionId)
  popRequests.set(next)
}

export function consumeDockPopover(sessionId: string): void {
  if (!popRequests.getSnapshot().has(sessionId)) return
  const next = new Set(popRequests.getSnapshot())
  next.delete(sessionId)
  popRequests.set(next)
}

export function useDockPopoverRequest(sessionId: string): boolean {
  return useSyncExternalStore(
    popRequests.subscribe,
    () => popRequests.getSnapshot().has(sessionId),
  )
}
