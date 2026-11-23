/**
 * The per-model policy dialog opened from the model-selector gear entry.
 * Renders the live context-pressure BudgetBar (the session's useProjection is
 * captured in the dialog request) plus the override editor; writes go through
 * the same debounced remote helpers as the settings page.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { remoteHandle } from './remote.js'
import { type Translator, useConfigDraft, useDebouncedWriter, useRemote, withTimeout } from './hooks.js'
import { bumpConfigRevision, closeDialog, useDialogRequest } from './dialog.js'
import type { UseProjection } from './sessionKit.js'
import { BudgetBar, type LiveBreakdown } from './BudgetBar.tsx'
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
  const [reserve, setReserve] = useState(8192)
  const [policy, setPolicy] = useState<ModelPolicyConfig | null>(null)

  // Seed `policy` from the fetched effective result ONCE per route; after
  // that it is the optimistic local copy (see DockPopover for the same rule).
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    seededFor.current = null
    setPolicy(null)
  }, [provider, model])
  useEffect(() => {
    if (effective.state.status !== 'ready') return
    // A route change leaves the previous route's result in `effective.state`
    // for one commit; seeding from it would adopt another model's override.
    if (effective.state.value.provider !== provider || effective.state.value.model !== model) return
    const key = `${provider}/${model}`
    if (seededFor.current === key) return
    seededFor.current = key
    setPolicy(effective.state.value.policy)
  }, [effective.state, provider, model])

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
    debounce(`${provider}/${model}:`, patchObj, async (pending) => {
      draft.begin()
      try {
        const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, pending))
        draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
        // Keep optimistic policy on success; refresh baseline only. Never merge
        // the server row back (resurrects deleted keys → reset bounce).
        if (result.ok) { bumpConfigRevision(); effective.reload() }
        else { seededFor.current = null; effective.reload() }
      } catch (error) {
        draft.mutate(error instanceof Error ? error.message : String(error))
        seededFor.current = null
        effective.reload()
      }
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
          <ReserveField value={reserve} t={t} onChange={setReserve} />
        </div>

        <div style={{ margin: '8px 0' }}>
          <Check
            checked={hasOverride}
            label={hasOverride ? t('policies.custom') : t('dialog.useGlobal')}
            onChange={(use) => {
              // Optimistic flip first (controlled checkboxes restore the prop
              // synchronously otherwise).
              if (use) {
                setPolicy({ provider, model })
                draft.begin()
                void debounce.enqueue(async () => {
                  try {
                    const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, {}))
                    draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
                    if (result.ok) { bumpConfigRevision(); effective.reload() }
                    else { seededFor.current = null; effective.reload() }
                  } catch (error) {
                    draft.mutate(error instanceof Error ? error.message : String(error))
                    seededFor.current = null
                    effective.reload()
                  }
                })
              } else {
                const previous = policy
                setPolicy(null)
                // Drop pending field writes that would upsert the row back.
                debounce.cancelByPrefix(`${provider}/${model}:`)
                draft.begin()
                void debounce.enqueue(async () => {
                  try {
                    const result = await withTimeout(remoteHandle().removeModelPolicy(provider, model))
                    draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
                    if (!result.ok) setPolicy(previous)
                    else {
                      setPolicy(null)
                      bumpConfigRevision()
                      effective.reload()
                    }
                  } catch (error) {
                    draft.mutate(error instanceof Error ? error.message : String(error))
                    setPolicy(previous)
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
