/**
 * The composer-dock meter registered on `conversation.composer.dock`
 * (list/session scope). It replaces the built-in ContextMeter, which is not
 * enrichable from outside: a plugin-injected stylesheet hides the stock
 * element and this component re-renders the stock contract — ring trigger
 * with percent caption, click-open anchored panel portal'ed to document.body
 * — plus our extra content:
 *
 *   trigger  — the stock 14px occupancy ring showing live usage percent,
 *              extended with an amber tick at the effective trigger point and
 *              an amber fill once usage reaches it. Native `title` gives the
 *              hover summary (trigger, used, projected, window).
 *   popover  — a portaled panel opening above the trigger, carrying live
 *              pressure reading, segment bar, and the three quick policy
 *              sliders writing per-model policy through the debounced remote.
 *
 * Positioning is MANUAL getBoundingClientRect math, deliberately not CSS
 * `position-anchor`: Chromium snaps anchor-positioned boxes into their
 * anchor's scroll container and scrolls it to keep the pair visible, so a
 * panel anchored into the streaming transcript dragged the whole page up.
 * The panel lives in document.body because the docked composer is a
 * fixed-position containing block that would clip an inline popover.
 *
 * `policy` (the optimistic per-model override) is owned by DockEntry, shared
 * with the popover by props, so the ring tick tracks slider drags in real
 * time; wire writes sync back through `useRemote` soft reloads that keep the
 * last value visible. `open` persists in module memory per session because
 * host config writes can remount this fiber.
 *
 * The model-menu gear entry requests this popover through
 * `requestDockPopover(sessionId)` since both seats are session fibers and the
 * gear cannot mount an overlay itself.
 *
 * Props: session standard kit only — the slot declares no owner props.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import { remoteHandle } from './remote.js'
import { type DebouncedWriter, type SaveState, type Translator, useConfigDraft, useDebouncedWriter, useRemote, withTimeout } from './hooks.js'
import { configRevision, consumeDockPopover, openDialog, useConfigRevision, useDockPopoverRequest } from './dialog.js'
import { createStore, type SnapshotStore } from './store.js'
import {
  type ContextPressureView,
  type ModelRoute,
  useModelRoute,
  type UseProjection,
} from './sessionKit.js'
import { formatTokens, ratioSliderBounds, retainTokens as retainOf, thresholdTokens as thresholdOf } from './format.js'
import type { LiveBreakdown } from './BudgetBar.tsx'
import { Check, MiniSlider, SaveStatus } from './controls.tsx'
import { DEFAULTS, resolveRetention, type MergedPolicy } from '../shared.js'
import type {
  EffectiveResult,
  ModelInfoResult,
  ModelPolicyConfig,
} from '../shared.js'

const TRIGGER_AMBER = '#e0af68'
// Ring geometry and strokes mirror ContextMeter.module.css exactly.
const RING_TRACK = 'var(--dsw-alias-border-l3, rgba(127,127,127,0.25))'
const RING_FILL = 'var(--dsw-alias-label-tertiary, rgba(122, 162, 247, 0.55))'
// Segment tints use the host chart tokens, same as the stock panel.
const SEG = {
  system: 'var(--dsw-alias-chart-system, #7aa2f7)',
  tools: 'var(--dsw-alias-chart-tools, #bb9af7)',
  messages: 'var(--dsw-alias-chart-messages, #73daca)',
  projected: 'var(--dsw-alias-chart-projected, #ff9e64)',
} as const

interface BreakdownShape {
  systemTokens?: number
  toolsTokens?: number
  messageTokens?: number
}

export interface DockEntryProps {
  sessionId: string
  useProjection?: UseProjection | undefined
  t: Translator
}

/**
 * Host slot fibers can be remounted by config writes; `open` persists in
 * module memory keyed by session so an already-open panel does not flash
 * closed/reopened. The optimistic `policy` lives in a module store too (below),
 * so a config-write remount never resets the sliders or the ring/bar indicators.
 */
const panelOpen = new Map<string, boolean>()

/** Optimistic per-route policy state, persisted across fiber remounts. */
interface DockPolicyState {
  routeKey: string | null
  policy: ModelPolicyConfig | null
  seeded: boolean
  /** Last external config revision this copy was seeded against. */
  revision: number
}
const dockPolicyStores = new Map<string, SnapshotStore<DockPolicyState>>()
function dockPolicyStore(sessionId: string): SnapshotStore<DockPolicyState> {
  let store = dockPolicyStores.get(sessionId)
  if (store === undefined) {
    store = createStore<DockPolicyState>({ routeKey: null, policy: null, seeded: false, revision: configRevision.getSnapshot() })
    dockPolicyStores.set(sessionId, store)
  }
  return store
}

export function DockEntry(props: DockEntryProps): JSX.Element | null {
  const { useProjection, t, sessionId } = props
  const route = useModelRoute(useProjection)
  const pressure = useProjection?.('contextPressure') as ContextPressureView | undefined
  const popRequested = useDockPopoverRequest(sessionId)
  const [open, setOpenState] = useState(() => panelOpen.get(sessionId) ?? false)
  const setOpen = (next: boolean): void => {
    panelOpen.set(sessionId, next)
    setOpenState(next)
  }
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // One-shot focus request from the model-menu gear entry.
  useEffect(() => {
    if (popRequested) {
      consumeDockPopover(sessionId)
      if (route !== undefined) setOpen(true)
    }
  }, [popRequested, sessionId, route])

  // Effective policy for the current route: ONE wire call shared by the
  // trigger (tick/caption) and the popover (global baseline). Soft-reloads
  // keep the last value — see useRemote.
  const effective = useRemote<EffectiveResult | null>(async () => {
    if (route === undefined) return { ok: true as const, value: null }
    return remoteHandle().effectiveFor(route.provider, route.model)
  }, [route?.provider, route?.model])

  // `base` is the global policy WITHOUT the override. A ⟲ reset must fall
  // back to this stable baseline, not to `merged`: `merged` carries the
  // override, and a soft reload keeps the OLD value visible for a while, so
  // resetting used to leave the slider showing the value just removed.
  const base = effective.state.status === 'ready' ? effective.state.value?.base : undefined

  // Per-model override policy lives HERE, not inside the popover: the ring's
  // amber tick must track the optimistic threshold while the slider is still
  // being dragged, before any wire write lands. `policy === null` means "no
  // override seeded yet", distinct from an empty override object.
  const draft = useConfigDraft(null)
  const debounce = useDebouncedWriter(700)
  const routeKey = route === undefined ? null : `${route.provider}/${route.model}`
  // Optimistic policy lives in a module store keyed by session, NOT in fiber
  // state, so a config-write remount cannot reset the indicators. The store
  // carries the active routeKey: a model switch re-seeds, a same-route remount
  // preserves the optimistic copy.
  const policyStore = dockPolicyStore(sessionId)
  const policySnap = useSyncExternalStore(policyStore.subscribe, policyStore.getSnapshot)
  const policy = policySnap.routeKey === routeKey ? policySnap.policy : null
  const setPolicy = useCallback((updater: SetStateAction<ModelPolicyConfig | null>): void => {
    const snap = policyStore.getSnapshot()
    const prev = snap.routeKey === routeKey ? snap.policy : null
    const next = typeof updater === 'function' ? updater(prev) : updater
    policyStore.set({ ...snap, routeKey, policy: next, seeded: true })
  }, [policyStore, routeKey])
  // A real route change resets the copy and re-arms seeding; a same-route
  // remount (config write) leaves the store untouched.
  useEffect(() => {
    const snap = policyStore.getSnapshot()
    if (snap.routeKey !== routeKey) policyStore.set({ ...snap, routeKey, policy: null, seeded: false })
  }, [routeKey, policyStore])
  // An edit committed from the settings page or the full dialog: re-arm
  // seeding and refetch so the ring and sliders show it. Tracked in the store
  // (not a ref) so a dock that was unmounted during the edit still catches up.
  const revision = useConfigRevision()
  const reloadEffective = effective.reload
  useEffect(() => {
    const snap = policyStore.getSnapshot()
    if (snap.revision === revision) return
    policyStore.set({ ...snap, seeded: false, revision })
    reloadEffective()
  }, [revision, policyStore, reloadEffective])
  // Seed the server baseline ONCE per route activation; afterwards the
  // optimistic copy is authoritative and reload/remount never overwrites it.
  useEffect(() => {
    if (route === undefined || effective.state.status !== 'ready') return
    const value = effective.state.value
    if (value === null) return
    // `useRemote` clears its value one commit AFTER the route changes, so the
    // first render on a new route still carries the PREVIOUS route's result.
    // Seeding from it would adopt the old model's override as this model's
    // policy and, with `seeded` set, never correct it.
    if (value.provider !== route.provider || value.model !== route.model) return
    const snap = policyStore.getSnapshot()
    if (snap.routeKey !== routeKey || snap.seeded) return
    policyStore.set({ ...snap, routeKey, policy: value.policy, seeded: true })
  }, [effective.state, route, routeKey, policyStore])

  /**
   * Write one or more override fields in ONE wire call; `null` deletes a key.
   *
   * The optimistic copy must mirror the server ROW, not just a bag of keys:
   * when ⟲ removes the last field the Host deletes the whole row, so `policy`
   * becomes null. Otherwise the "custom policy" checkbox stays checked on a
   * row that no longer exists and the reset looks like it did nothing.
   * On failure we re-arm seeding (`seeded: false`) and reload, letting the
   * server snapshot become the source of truth instead of a fake override.
   */
  const applyFields = (patchObj: Record<string, unknown>): void => {
    if (route === undefined) return
    const { provider, model } = route
    setPolicy(prev => {
      const next: Record<string, unknown> = { provider, model, ...(prev ?? {}) }
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
        if (result.ok) {
          // Keep the optimistic policy; refresh only the global baseline used
          // as the display fallback. NEVER merge the server row back — that
          // resurrects optimistically-deleted keys (the reset bounce).
          effective.reload()
        } else {
          policyStore.set({ ...policyStore.getSnapshot(), seeded: false })
          effective.reload()
        }
      } catch (error) {
        draft.mutate(error instanceof Error ? error.message : String(error))
        policyStore.set({ ...policyStore.getSnapshot(), seeded: false })
        effective.reload()
      }
    })
  }

  const onField = (key: string, value: unknown): void => applyFields({ [key]: value })

  // The amber tick marks the REAL trigger point, not the raw thresholdRatio:
  // threshold = floor(min(W*ratio, W - reserve - headroom)). With the default
  // headroom that is ~42% of the window, not 80% — the ratio alone would put
  // the tick (and the amber warning) far past where the engine already fired.
  const ratio = policy?.thresholdRatio ?? base?.thresholdRatio ?? DEFAULTS.thresholdRatio
  const headroom = policy?.headroomTokens ?? base?.headroomTokens ?? DEFAULTS.headroomTokens
  const w = pressure?.contextWindow
  const percent = route !== undefined && useProjection !== undefined
    ? (w !== undefined && w > 0
      ? Math.round((thresholdOf(w, ratio, headroom, 8192) / w) * 100)
      : Math.round(ratio * 100))
    : undefined

  // Close on outside pointer / Escape, mirroring ContextMeter's dismissal.
  // The panel is portal'ed, so "inside" spans two subtrees.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      const inside = rootRef.current?.contains(event.target) === true
        || panelRef.current?.contains(event.target) === true
      if (!inside) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Route drop while open → close instead of showing a stale policy editor.
  useEffect(() => {
    if (open && route === undefined) setOpen(false)
  }, [open, route])

  const used = pressure?.pressureTokens ?? 0
  const projected = pressure?.projectedTokens ?? used
  const window = pressure?.contextWindow
  const usedPct = window !== undefined && window > 0 ? Math.min(100, (projected / window) * 100) : 0
  const enabled = route !== undefined && useProjection !== undefined

  const tip = enabled
    ? [
      t('dock.tip.trigger', { percent: percent ?? '?' }),
      window !== undefined
        ? t('dock.tip.pressure', {
          used: formatTokens(used),
          projected: formatTokens(projected),
          window: formatTokens(window),
        })
        : null,
      t('dock.tip.open'),
    ].filter(line => line !== null).join('\n')
    : t('dock.noModel')

  // Usage-reached-trigger state: the fill flips to the trigger amber so the
  // ring itself warns that compaction is imminent (the caption stays usage %).
  const atTrigger = enabled && percent !== undefined && usedPct >= percent
  const reading = enabled && pressure?.contextWindow !== undefined ? `${Math.round(usedPct)}%` : '—'
  const tick = percent !== undefined ? Math.min(99, Math.max(1, percent)) : undefined

  return (
    <span
      ref={rootRef}
      data-composer-stat="compact-tool"
      style={{ display: 'inline-flex' }}
    >
      <button
        type="button"
        className="dsh-compact-trigger"
        disabled={!enabled}
        title={tip}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flex: 'none',
          border: 'none',
          borderRadius: 'var(--dsw-radius-sm, 4px)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-tertiary, inherit)',
          fontFamily: 'inherit',
          fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
          lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
          padding: '1px 8px',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          cursor: enabled ? 'pointer' : 'default',
          opacity: enabled ? 1 : 0.4,
        }}
        onClick={() => { if (enabled) setOpen(!open) }}
      >
        {/* Stock 14px occupancy ring; the amber tick marks the trigger point. */}
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r={5.5} style={{ fill: 'none', stroke: RING_TRACK, strokeWidth: 2 }} />
          {usedPct > 0 && (
            <circle
              cx="7" cy="7" r={5.5}
              style={{
                fill: 'none',
                stroke: atTrigger ? TRIGGER_AMBER : RING_FILL,
                strokeWidth: 2,
                strokeLinecap: 'round',
                strokeDasharray: `${CIRC * Math.min(100, usedPct) / 100} ${CIRC}`,
              }}
              transform="rotate(-90 7 7)"
            />
          )}
          {tick !== undefined && (
            <line
              x1="7" y1="0" x2="7" y2="2.4"
              stroke={TRIGGER_AMBER} strokeWidth="1.6" strokeLinecap="round"
              transform={`rotate(${(tick / 100) * 360} 7 7)`}
            />
          )}
        </svg>
        <span>{reading}</span>
      </button>
      {open && route !== undefined && useProjection !== undefined && createPortal(
        <DockPopover
          sessionId={sessionId}
          route={route}
          useProjection={useProjection}
          t={t}
          panelRef={panelRef}
          anchorRef={rootRef}
          base={base ?? null}
          policy={policy}
          setPolicy={setPolicy}
          draft={draft}
          onField={onField}
          onFields={applyFields}
          onWritten={effective.reload}
          onClose={() => { setOpen(false) }}
          writer={debounce}
        />,
        document.body,
      )}
    </span>
  )
}

/** Ring geometry: 14px viewBox, 2px stroke — identical to the stock meter. */
const CIRC = 2 * Math.PI * 5.5

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

interface DockPopoverProps {
  sessionId: string
  route: ModelRoute
  useProjection: UseProjection
  t: Translator
  /** Outside-dismiss + manual positioning both need the portaled panel element. */
  panelRef: RefObject<HTMLDivElement>
  /** The trigger root the panel is glued to (`getBoundingClientRect` math). */
  anchorRef: RefObject<HTMLElement>
  /** Global baseline (WITHOUT this route's override), shared with the trigger.
      Sliders read `policy ?? base`, so ⟲ shows the inherited value at once. */
  base: MergedPolicy | null
  policy: ModelPolicyConfig | null
  setPolicy: Dispatch<SetStateAction<ModelPolicyConfig | null>>
  draft: SaveState
  onField(key: string, value: unknown): void
  /** One wire write for several keys (retainRatio must clear retainTokens). */
  onFields(patch: Record<string, unknown>): void
  /** Shared debounced writer: removal must cancel/reorder pending field writes. */
  writer: DebouncedWriter
  /** Called after every wire write resolves so the baseline re-syncs in the
      background (soft reload keeps the panel stable). */
  onWritten(): void
  onClose(): void
}

/* Compact popover in the built-in meter's size class: header figures, one
 * segmented live bar carrying the trigger tick, legend rows, then the three
 * quick controls. "More settings" hands off to the full root dialog. */

/** Stock panel `.row`: space-between, label secondary, value primary. */
const SWATCH = { width: 8, height: 8, borderRadius: 2, flexShrink: 0, display: 'inline-block', marginRight: 6 } as const

function legendRow(label: string, value: string, color?: string): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}>
      <span style={{ color: 'var(--dsw-alias-label-secondary, inherit)' }}>
        <span style={{ ...SWATCH, background: color ?? 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.5))' }} aria-hidden />
        {label}
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary, inherit)' }}>{value}</span>
    </div>
  )
}

function DockPopover(props: DockPopoverProps): JSX.Element {
  const { provider, model } = props.route
  const { useProjection, t, draft, base, policy, setPolicy, onField, onFields } = props

  // `modelInfo` only supplies the context-window estimate when live pressure
  // is absent; policy/base/onField are hoisted to DockEntry (shared with the
  // ring tick), this fetch stays local.
  const info = useRemote<ModelInfoResult | null>(
    async () => remoteHandle().modelInfo(provider, model).then(r => r, () => ({ ok: false as const, error: {} })),
    [provider, model],
  )

  const pressure = useProjection('contextPressure') as ContextPressureView | undefined
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

  const hasOverride = policy !== null
  type NumericKey = 'thresholdRatio' | 'headroomTokens' | 'retainRatio' | 'retainTokens' | 'maxTokens' | 'compactionRetries' | 'maxOverflowRetries'
  // Reset target is the GLOBAL baseline, never `merged` (which still carries
  // the override). This makes ⟲ show the inherited value on the very next
  // render instead of waiting for a soft reload.
  const shown = (key: NumericKey): number =>
    (policy?.[key] as number | undefined) ?? base?.[key] ?? 0
  const overridden = (key: NumericKey): boolean =>
    typeof policy?.[key] === 'number'

  const bounds = ratioSliderBounds(base ?? {}, policy ?? {})
  const retention = resolveRetention(base ?? {}, policy)

  const resetMark = (key: NumericKey): JSX.Element | undefined => {
    if (!overridden(key)) return undefined
    return (
      <button
        type="button"
        title={t('mini.reset')}
        style={{ border: 'none', background: 'transparent', color: '#e0af68', cursor: 'pointer', fontSize: 12, padding: 0 }}
        onClick={() => { onField(key, null) }}
      >⟲</button>
    )
  }

  // Manual anchoring, intentionally NOT CSS `position-anchor`: Chromium snaps
  // an anchor-positioned box into its anchor's scroll container and can even
  // scroll that container to keep the pair visible — inside the streaming
  // transcript that drags the whole page upward whenever output arrives.
  // Plain rect math keeps the panel glued to the trigger without ever
  // touching scroll state.
  useLayoutEffect(() => {
    const panel = props.panelRef.current
    const anchor = props.anchorRef.current
    if (panel === null || anchor === null) return
    const position = (): void => {
      const a = anchor.getBoundingClientRect()
      const h = panel.offsetHeight
      const w = panel.offsetWidth
      const topInset = Math.max(12, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-overlay-top')) || 0)
      const aboveFits = a.top - 8 - h >= topInset
      const top = aboveFits ? a.top - 8 - h : Math.min(Math.max(topInset, a.bottom + 8), window.innerHeight - 12 - h)
      panel.style.top = `${top}px`
      panel.style.left = `${Math.max(12, Math.min(a.right - w, window.innerWidth - 12 - w))}px`
      panel.style.visibility = 'visible'
    }
    position()
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    const observer = new ResizeObserver(position)
    observer.observe(panel)
    observer.observe(anchor)
    return () => {
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      observer.disconnect()
    }
  }, [props.panelRef, props.anchorRef])

  const used = live?.pressureTokens ?? 0
  const projected = live?.projectedTokens ?? used
  const W = contextWindow ?? 0
  const reserve = 8192
  const triggerTokens = W > 0 && base !== null
    ? thresholdOf(W, shown('thresholdRatio'), shown('headroomTokens'), reserve)
    : 0
  const triggerPct = base !== null ? Math.round(shown('thresholdRatio') * 100) : 0
  const usedPct = W > 0 ? (Math.min(100, (used / W) * 100)) : 0
  const projPct = W > 0 ? Math.min(100, (projected / W) * 100) : 0
  const triggerX = W > 0 ? Math.min(100, (triggerTokens / W) * 100) : 0
  const retainedTokens = W > 0 && base !== null
    ? retainOf(W, reserve, retention.retainRatio ?? DEFAULTS.retainRatio, retention.retainTokens)
    : 0
  const retainX = W > 0 ? Math.min(100, retainedTokens / W * 100) : 0

  // Segments mirror ContextMeter: breakdown proportions scaled to live usage.
  const bTotal = (live?.systemTokens ?? 0) + (live?.toolsTokens ?? 0) + (live?.messageTokens ?? 0)
  const segments = live !== undefined && used > 0 && bTotal > 0
    ? ([
      ['system', SEG.system, (live.systemTokens ?? 0)],
      ['tools', SEG.tools, (live.toolsTokens ?? 0)],
      ['messages', SEG.messages, (live.messageTokens ?? 0)],
    ] as Array<[string, string, number]>).map(([key, color, v]) => ({ key, color, width: usedPct * v / bTotal })).filter(s => s.width > 0)
    : []

  return (
    <div
      ref={props.panelRef}
      role="dialog"
      aria-label={t('dock.title', { provider, model })}
      style={{
        // Menu-surface look mirrors ContextMeter `.panel` token-for-token;
        // top/left are written by the positioning effect above.
        position: 'fixed',
        zIndex: 1100,
        boxSizing: 'border-box',
        width: 'min(320px, calc(100vw - 24px))',
        padding: 12,
        border: 0,
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        background: 'var(--dsw-specific-menu, var(--dsh-surface, #1f1f2e))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 32px rgba(0,0,0,0.4))',
        fontSize: 12,
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        cursor: 'default',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)))',
        overflowX: 'hidden',
        overflowY: 'auto',
        margin: 0,
        visibility: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
        '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
        '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
      } as CSSProperties}
    >
      {/* Header — mirrors the stock card: tertiary headline, primary reading,
          tabular figures pushed right, then the close button (our addition). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--dsw-alias-label-tertiary, inherit)' }}>{t('dock.cardTitle')}</span>
        <span style={{ fontWeight: 500, color: 'var(--dsw-alias-label-primary, inherit)' }}>
          {W > 0 ? `${Math.round(usedPct)}%` : '—'}
        </span>
        <span style={{ marginLeft: 'auto', fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary, inherit)' }}>
          {W > 0 ? `~${formatTokens(used)} / ${formatTokens(W)}` : '—'}
        </span>
        <button
          type="button"
          aria-label={t('dialog.close')}
          style={{ border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-tertiary, inherit)', cursor: 'pointer', fontSize: 13, padding: '0 0 0 4px' }}
          onClick={props.onClose}
        >✕</button>
      </div>

      {/* Live bar — stock `.bar` geometry (4px pill, 1px segment gaps, chart
          tints) plus our trigger tick / projected overlay / retain tail. */}
      {W > 0 ? (
        <div style={{ position: 'relative', display: 'flex', gap: 1, margin: '10px 0 12px', height: 4, borderRadius: 999, background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))' }}>
          {segments.map(s => (
            <div key={s.key} style={{ flex: 'none', width: `${s.width}%`, minWidth: 2, height: '100%', borderRadius: 1, background: s.color }} />
          ))}
          {live === undefined && usedPct === 0 && (
            <div style={{ flex: 'none', width: `${triggerX}%`, height: '100%', borderRadius: 1, background: 'var(--dsw-alias-label-tertiary, rgba(122,162,247,0.28))', opacity: 0.5 }} />
          )}
          {projPct > usedPct && (
            <div style={{ position: 'absolute', left: `${usedPct}%`, width: `${projPct - usedPct}%`, top: 0, bottom: 0, background: 'rgba(255,158,100,0.45)', borderRadius: 1 }} />
          )}
          <div title={`${t('bar.threshold')}: ${formatTokens(triggerTokens)}`} style={{ position: 'absolute', left: `calc(${triggerX}% - 1px)`, top: -2, bottom: -2, width: 2, background: TRIGGER_AMBER, borderRadius: 1 }} />
          {retainX > 0 && (
            <div title={`${t('bar.retain')}: ${formatTokens(retainedTokens)}`} style={{ position: 'absolute', left: `${retainX}%`, top: 6, width: 2, height: 4, background: '#9ece6a', borderRadius: 1 }} />
          )}
        </div>
      ) : (
        <div style={{ color: 'var(--dsw-alias-label-tertiary, inherit)', margin: '10px 0 12px' }}>{t('bar.noLive')}</div>
      )}

      {/* Legend rows — same composition as the stock card's dt/dd list. */}
      <div style={{ marginTop: 6 }}>
        {live !== undefined && bTotal > 0 && (
          <>
            {legendRow(t('bar.seg.system'), `~${formatTokens(live.systemTokens ?? 0)}`, SEG.system)}
            {legendRow(t('bar.seg.tools'), `~${formatTokens(live.toolsTokens ?? 0)}`, SEG.tools)}
            {legendRow(t('bar.seg.messages'), `~${formatTokens(live.messageTokens ?? 0)}`, SEG.messages)}
          </>
        )}
        {live !== undefined && legendRow(t('bar.live'), formatTokens(used))}
        {live !== undefined && projPct > 0 && legendRow(t('bar.projected'), formatTokens(projected), SEG.projected)}
        {base !== null && W > 0 && legendRow(t('bar.threshold'), `${formatTokens(triggerTokens)} (${triggerPct}%)`, TRIGGER_AMBER)}
        {base !== null && W > 0 && legendRow(t('bar.retain'), formatTokens(retainedTokens), '#9ece6a')}
        {base !== null && legendRow(t('bar.headroom'), formatTokens(shown('headroomTokens')))}
      </div>

      {/* Quick controls — the compact three; everything else lives in "更多设置". */}
      {base !== null && (
        <div style={{ borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))', marginTop: 6, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <MiniSlider
            label={t('mini.trigger')}
            value={shown('thresholdRatio')}
            min={bounds.thresholdMin} max={bounds.thresholdMax} step={0.01}
            format={v => `${Math.round(v * 100)}%`}
            onChange={v => { onField('thresholdRatio', v) }}
            extra={resetMark('thresholdRatio')}
          />
          <MiniSlider
            label={t('mini.headroom')}
            value={shown('headroomTokens')}
            min={1024} max={262144} step={1024}
            onChange={v => { onField('headroomTokens', v) }}
            extra={resetMark('headroomTokens')}
          />
          <MiniSlider
            label={t('mini.retain')}
            value={Math.min(bounds.retainMax, shown('retainRatio'))}
            min={bounds.retainMin} max={bounds.retainMax} step={Math.min(0.01, bounds.retainMax)}
            format={v => `${Math.round(v * 100)}%`}
            onChange={v => { onFields({ retainRatio: v, retainTokens: null }) }}
            extra={resetMark('retainRatio')}
          />
        </div>
      )}

      <Check
        checked={hasOverride}
        label={t('mini.perModel')}
        onChange={(use) => {
          // Optimistic flip first: a controlled checkbox restores its prop
          // synchronously when onChange does not update state, so without
          // this the tick visibly bounces until the write resolves.
          if (use) {
            setPolicy({ provider, model })
            draft.begin()
            void props.writer.enqueue(async () => {
              try {
                const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, {}))
                draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
                if (result.ok) props.onWritten()
                else setPolicy(null)
              } catch (error) {
                draft.mutate(error instanceof Error ? error.message : String(error))
                setPolicy(null)
              }
            })
          } else {
            const previous = policy
            setPolicy(null)
            // A pending field write would upsert the row straight back.
            props.writer.cancelByPrefix(`${provider}/${model}:`)
            draft.begin()
            void props.writer.enqueue(async () => {
              try {
                const result = await withTimeout(remoteHandle().removeModelPolicy(provider, model))
                draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
                if (!result.ok) setPolicy(previous)
                else {
                  setPolicy(null)
                  props.onWritten()
                }
              } catch (error) {
                draft.mutate(error instanceof Error ? error.message : String(error))
                setPolicy(previous)
              }
            })
          }
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          style={{ border: 'none', background: 'transparent', color: '#7aa2f7', cursor: 'pointer', fontSize: 12, padding: 0 }}
          onClick={() => {
            props.onClose()
            openDialog({
              sessionId: props.sessionId,
              provider,
              model,
              useProjection,
            })
          }}
        >{t('mini.more')}</button>
        <span style={{ flex: 1 }} />
        <SaveStatus saving={draft.saving} error={draft.error} savedAt={draft.savedAt} t={t} />
      </div>
    </div>
  )
}
