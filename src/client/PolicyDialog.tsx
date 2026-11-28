/**
 * The per-model policy dialog opened from the model-selector gear entry.
 * Renders the live context-pressure BudgetBar (the session's useProjection is
 * captured in the dialog request) plus the override editor; writes go through
 * the same debounced remote helpers as the settings page.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { remoteHandle } from './remote.js'
import { type Translator, useConfigDraft, useDebouncedWriter, useRemote, useWriteDirtiness, withTimeout } from './hooks.js'
import { policyScope, scopeDirty } from './writeQueue.js'
import { reserveStore, setReserveTokens } from './preview.js'
import { bumpConfigRevision, closeDialog, useConfigRevision, useDialogRequest } from './dialog.js'
import type { UseProjection } from './sessionKit.js'
import { BudgetBar, type LiveBreakdown } from './BudgetBar.tsx'
import { clearViolatesRuntimeInvariant } from './format.js'
import { PolicyEditor, ReserveField } from './PolicyEditor.tsx'
import { DEFAULTS, resolveRetention, type MergedPolicy } from '../shared.js'
import { btn, Check, SaveStatus, sectionSub, sectionTitle } from './controls.tsx'
import type {
  CatalogResult,
  EffectiveResult,
  ModelInfoResult,
  ModelPolicyConfig,
} from '../shared.js'

export interface PolicyDialogProps {
  sessionId: string
  provider: string
  model: string
  useProjection: UseProjection
  t: Translator
  catalog: CatalogResult | null
}

interface PressureShape {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

interface BreakdownShape {
  systemTokens?: number
  toolsTokens?: number
  messageTokens?: number
}

export function PolicyDialog(props: PolicyDialogProps): JSX.Element {
  const { provider, model, useProjection, t } = props

  const effective = useRemote<EffectiveResult>(() => remoteHandle().effectiveFor(provider, model), [provider, model])
  const info = useRemote<ModelInfoResult | null>(
    async () => remoteHandle().modelInfo(provider, model).then(r => r, () => ({ ok: false as const, error: {} })),
    [provider, model],
  )
  const draft = useConfigDraft(null)
  const debounce = useDebouncedWriter(700)
  // Shared reserve estimate — one store across settings page, dialog and dock.
  const reserve = useSyncExternalStore(reserveStore().subscribe, reserveStore().getSnapshot)
  const [policy, setPolicy] = useState<ModelPolicyConfig | null>(null)

  // Seed `policy` from the fetched effective result ONCE per route; after
  // that it is the optimistic local copy (see DockPopover for the same rule).
  const seededFor = useRef<string | null>(null)
  // Failure-backoff state: conclusions with no usable resolution (hard
  // errors, retry exhaustion) must not refire immediately — a persistently
  // failing remote would hot-loop. The timer only arms the next effect run.
  const backoffFailures = useRef(0)
  const backoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [backoffTick, setBackoffTick] = useState(0)
  useEffect(() => () => {
    if (backoffTimer.current !== null) clearTimeout(backoffTimer.current)
  }, [])
  useEffect(() => {
    seededFor.current = null
    needFetch.current = true
    awaitingResolution.current = false
    chainAtReload.current = undefined
    backoffFailures.current = 0
    if (backoffTimer.current !== null) { clearTimeout(backoffTimer.current); backoffTimer.current = null }
    setPolicy(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, model])

  // Cross-entry convergence, same state machine as the dock: any successful
  // write bumps the revision (this dialog's own writes included); a revision
  // reseed may ONLY apply the resolution of a fetch started after the bump,
  // and never while the write scope is dirty. The dialog is a single overlay
  // fiber that is not remounted by config writes, so fiber-local refs suffice
  // where the dock needs its module store.
  const revision = useConfigRevision()
  const anyDirty = useWriteDirtiness(policyScope(provider, model))
  const seenRevision = useRef(revision)
  // needFetch from birth: the first seed also goes through the attribution
  // cycle — the initial automatic fetch can race a write committed just before
  // the dialog opened, and only a post-bump resolution is provably fresh.
  const needFetch = useRef(true)
  const awaitingResolution = useRef(false)
  const chainAtReload = useRef<number | undefined>(undefined)
  const revisionAtFetch = useRef<number>(revision)
  useEffect(() => {
    if (seenRevision.current === revision) return
    seenRevision.current = revision
    needFetch.current = true
    // Write activity is finite and converges on its own; it must not inherit
    // the failure backoff.
    backoffFailures.current = 0
    if (backoffTimer.current !== null) { clearTimeout(backoffTimer.current); backoffTimer.current = null }
    // No reload here: the unified effect below owns the fetch/apply sequence,
    // and firing it now would race the dirty window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
  useEffect(() => {
    const key = `${provider}/${model}`
    if (seededFor.current === key && !needFetch.current) return
    if (scopeDirty(policyScope(provider, model))) return
    if (awaitingResolution.current) {
      // The resolution counts as OURS only when a chain NEWER than the
      // fire-time epoch concluded (state-identity comparison misses retry
      // exhaustion and soft reloads entirely). Apply ONLY when the revision
      // is unchanged since fire time: a resolution that crossed a write
      // commit predates it and must be discarded and refired.
      const epochAtFire = chainAtReload.current ?? 0
      if (effective.concludedChain <= epochAtFire) return
      awaitingResolution.current = false
      chainAtReload.current = undefined
      if (effective.resolvedChain > epochAtFire) {
        // A SUCCESSFUL resolution of the chain we fired — `resolvedChain`,
        // not `concludedChain`: failures conclude chains while the visible
        // state still carries the stale pre-write value, and applying that
        // resurrects exactly the snapshot this machine exists to reject.
        backoffFailures.current = 0
        if (revisionAtFetch.current === revision
          && effective.state.status === 'ready'
          && effective.state.value.provider === provider && effective.state.value.model === model) {
          needFetch.current = false
          seededFor.current = key
          setPolicy(effective.state.value.policy)
          return
        }
        // Resolution crossed a write commit: discard and refire immediately —
        // write activity is bounded, so this never loops.
      } else {
        // Concluded WITHOUT a usable resolution (hard error / retry
        // exhaustion). An immediate refire would hot-loop a persistently
        // failing remote — back off exponentially instead.
        backoffFailures.current += 1
        if (backoffTimer.current === null) {
          const delay = Math.min(30000, 1000 * (2 ** (backoffFailures.current - 1)))
          backoffTimer.current = setTimeout(() => {
            backoffTimer.current = null
            setBackoffTick(n => n + 1)
          }, delay)
        }
        return
      }
    }
    if (!awaitingResolution.current) {
      // An armed backoff timer owns the next fire (see DockEntry for the
      // full rationale): firing on a dirty/quiet transition inside the
      // backoff window bypasses the promised spacing.
      if (backoffTimer.current !== null) return
      chainAtReload.current = effective.chainEpoch
      revisionAtFetch.current = revision
      awaitingResolution.current = true
      effective.reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective.state, effective.concludedChain, effective.resolvedChain, provider, model, anyDirty, revision, backoffTick])

  // Global baseline WITHOUT the override: the reset/inherit target. `merged`
  // still carries this row's overrides, so using it as `base` made "inherit"
  // show the value that was just removed until a soft reload landed.
  const base: MergedPolicy | null = effective.state.status === 'ready' ? effective.state.value.base : null

  // Live projections (hooks must run unconditionally at top level).
  const pressure = useProjection('contextPressure') as PressureShape | undefined
  const breakdown = useProjection('contextBreakdown') as BreakdownShape | undefined
  const live: LiveBreakdown | undefined = pressure === undefined ? undefined : {
    pressureTokens: pressure.pressureTokens,
    projectedTokens: pressure.projectedTokens,
    contextWindow: pressure.contextWindow,
    systemTokens: breakdown?.systemTokens,
    toolsTokens: breakdown?.toolsTokens,
    messageTokens: breakdown?.messageTokens,
  }

  const contextWindow = live?.contextWindow
    ?? (info.state.status === 'ready' ? info.state.value?.contextWindow : undefined)
  const windowPending = contextWindow === undefined && info.state.status === 'loading'

  const apply = (patchObj: Record<string, unknown>) => {
    setPolicy(prev => {
      const next = { provider, model, ...(prev ?? {}) } as Record<string, unknown>
      for (const [key, value] of Object.entries(patchObj)) {
        if (value === null) delete next[key]
        else next[key] = value
      }
      const hasFields = Object.keys(next).some(k => k !== 'provider' && k !== 'model')
      return hasFields ? next as unknown as ModelPolicyConfig : null
    })
    debounce(policyScope(provider, model), patchObj, {
      // One remote write for the merged patch; `begin`/`settle` pair exactly
      // once per submitter even when edits merge into one wire write.
      commit: async (pending) => {
        const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, pending))
        if (!result.ok) throw new Error(result.error?.message ?? 'error')
        // Keep optimistic policy on success; the bump converges every entry.
        // Never merge the server row back (resurrects deleted keys → reset bounce).
        bumpConfigRevision()
      },
      begin: () => { draft.begin() },
      settle: (err) => {
        draft.mutate(err)
        if (err !== undefined) {
          seededFor.current = null
          needFetch.current = true
        }
      },
    })
  }

  const onField = (key: string, value: unknown) => apply({ [key]: value })

  const close = () => { closeDialog() }
  // The overlay div is not focusable, so a keydown handler on it never fires
  // while focus sits on the body. Listen on document instead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeDialog() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [])
  const hasOverride = policy !== null
  const retention = resolveRetention(base ?? {}, policy)

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div style={{
        width: 640, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto',
        background: 'var(--dsh-surface, #1a1b26)',
        color: 'inherit',
        border: '1px solid rgba(127,127,127,0.3)',
        borderRadius: 10,
        padding: '16px 20px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={sectionTitle}>{t('dialog.title', { provider, model })}</div>
            <div style={sectionSub}>{t('dialog.subtitle')}</div>
          </div>
          <SaveStatus saving={draft.saving} error={draft.error} savedAt={draft.savedAt} t={t} />
          <button style={btn} onClick={close}>{t('dialog.close')}</button>
        </div>

        {live === undefined && (
          <p style={{ fontSize: 11, opacity: 0.6 }}>{t('bar.noLive')}</p>
        )}
        {contextWindow !== undefined && contextWindow > 0 && base !== null && (
          <BudgetBar
            contextWindow={contextWindow}
            thresholdRatio={policy?.thresholdRatio ?? base.thresholdRatio}
            headroomTokens={policy?.headroomTokens ?? base.headroomTokens}
            retainRatio={retention.retainRatio ?? DEFAULTS.retainRatio}
            retainTokens={retention.retainTokens}
            reserveTokens={reserve}
            live={live}
            t={t}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <ReserveField value={reserve} t={t} onChange={setReserveTokens} />
        </div>

        <div style={{ margin: '8px 0' }}>
          <Check
            checked={hasOverride}
            disabled={hasOverride && windowPending}
            label={hasOverride ? t('policies.custom') : t('dialog.useGlobal')}
            onChange={(use) => {
              // Optimistic flip first (controlled checkboxes restore the prop
              // synchronously otherwise).
              const scope = policyScope(provider, model)
              const reseedOnFailure = (): void => {
                // Failure rollback is ALWAYS the reseed channel: `policy` may
                // carry fields whose writes were cancelled in the meantime
                // (resurrecting them on restore) — the attribution machine
                // fetches server truth through a post-bump resolution instead.
                seededFor.current = null
                needFetch.current = true
              }
              if (use) {
                setPolicy({ provider, model })
                // Ordering is causal: `enqueueWrite` flushes any pending
                // debounced write (the older user intent) onto the chain
                // ahead of this create, so reset-then-recreate converges to
                // the empty row instead of silently dropping the reset.
                draft.begin()
                void debounce.enqueueWrite(scope, async () => {
                  try {
                    const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, {}))
                    draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
                    if (result.ok) bumpConfigRevision()
                    else reseedOnFailure()
                  } catch (error) {
                    draft.mutate(error instanceof Error ? error.message : String(error))
                    reseedOnFailure()
                  }
                })
              } else {
                // Unchecking IS the whole-row removal — same runtime-invariant
                // gate as the dock and the settings row delete: refuse the
                // collapse when the known-window inheritance is a budget the
                // engine rejects at runtime.
                if (windowPending || clearViolatesRuntimeInvariant(contextWindow, reserve, 'headroomTokens', {}, base ?? {})) return
                setPolicy(null)
                // The pending field write (if any) flushes onto the chain
                // ahead of this removal, so the removal lands last.
                draft.begin()
                void debounce.enqueueWrite(scope, async () => {
                  try {
                    const result = await withTimeout(remoteHandle().removeModelPolicy(provider, model))
                    draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
                    if (!result.ok) reseedOnFailure()
                    else bumpConfigRevision()
                  } catch (error) {
                    draft.mutate(error instanceof Error ? error.message : String(error))
                    reseedOnFailure()
                  }
                })
              }
            }}
          />
        </div>

        {effective.state.status === 'loading' && <div style={{ opacity: 0.6 }}>…</div>}
        {effective.state.status === 'error' && (
          <div style={{ color: '#f7768e', fontSize: 12 }}>
            {t('load.error', { message: effective.state.error.message })}
          </div>
        )}
        {base !== null && (
          <PolicyEditor
            config={policy ?? {}}
            base={base}
            override
            catalog={props.catalog}
            t={t}
            onField={onField}
            onFields={p => { apply(p) }}
            contextWindow={contextWindow}
            reserveTokens={reserve}
            capsPending={windowPending}
          />
        )}
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}

/** Root overlay component registered on `shell.overlay`; owns the open request. */
export function PolicyDialogHost(props: { t: Translator }): JSX.Element | null {
  const request = useDialogRequest()
  const catalog = useRemote<CatalogResult | null>(
    async () => request === null ? { ok: true, value: null } : remoteHandle().catalog(),
    [request === null],
  )
  if (request === null) return null
  return (
    <PolicyDialog
      sessionId={request.sessionId}
      provider={request.provider}
      model={request.model}
      useProjection={request.useProjection}
      t={props.t}
      catalog={catalog.state.status === 'ready' ? catalog.state.value : null}
    />
  )
}
