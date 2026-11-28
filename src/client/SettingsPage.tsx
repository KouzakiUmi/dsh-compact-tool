/**
 * The `settings.section` page: global policy editor + budget-bar preview +
 * the list of per-model overrides. Every field write debounces into one
 * `patchGlobal`/`setModelPolicy` wire call per control burst. The optimistic
 * draft is the UI's source of truth; only a failed write re-seeds it from the
 * server. A successful write bumps the config revision so the dock catches up.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { remoteHandle } from './remote.js'
import { clearViolatesRuntimeInvariant } from './format.js'
import {
  type Translator,
  useConfigDraft,
  useDebouncedWriter,
  useRemote,
  withTimeout,
} from './hooks.js'
import {
  btnDanger,
  btnPrimary,
  card,
  Check,
  labelCell,
  row,
  SaveStatus,
  sectionSub,
  sectionTitle,
  Select,
} from './controls.tsx'
import { PolicyEditor, ReserveField } from './PolicyEditor.tsx'
import { BudgetBar } from './BudgetBar.tsx'
import { parseRoute } from './sessionKit.ts'
import { summarizationIssue } from './health.js'
import { bumpConfigRevision, configRevision, useConfigRevision } from './dialog.js'
import { GLOBAL_SCOPE, anyScopeDirty, policyScope } from './writeQueue.js'
import { reserveStore, setReserveTokens } from './preview.js'
import type {
  CatalogResult,
  CompactConfig,
  DescribeResult,
  ModelInfoResult,
  ModelPolicyConfig,
} from '../shared.js'
import { DEFAULTS, mergePolicy, type MergedPolicy, resolveRetention } from '../shared.js'

export interface SettingsPageProps {
  close(): void
  t: Translator
}

export function SettingsPage(props: SettingsPageProps): JSX.Element {
  const { t } = props
  const describe = useRemote<DescribeResult>(() => remoteHandle().describe(), [])
  const catalog = useRemote<CatalogResult>(() => remoteHandle().catalog(), [])
  const [previewModel, setPreviewModel] = useState('')
  const reserve = useSyncExternalStore(reserveStore().subscribe, reserveStore().getSnapshot)

  const ready = describe.state.status === 'ready' ? describe.state.value : null
  const draft = useConfigDraft(ready?.config ?? null)
  const debounce = useDebouncedWriter(700)

  // Pick a sensible preview model once the catalog lands.
  useEffect(() => {
    if (previewModel !== '') return
    if (catalog.state.status !== 'ready') return
    const value = catalog.state.value
    const first = value.providers
      .flatMap(p => (value.models[p.id] ?? []).map(m => `${p.id}/${m.model}`))[0]
    if (first !== undefined && first !== '') setPreviewModel(first)
  }, [catalog.state, previewModel])

  const preview = useRemote<ModelInfoResult | null>(async () => {
    if (previewModel === '') return { ok: true, value: null }
    const { provider, model } = parseRoute(previewModel)
    return remoteHandle().modelInfo(provider, model)
  }, [previewModel])

  // The budget bar previews the OPTIMISTIC draft (global + the previewed
  // route's override), merged with the same single-source math the host's
  // effectiveFor uses. A server snapshot here lagged behind slider drags and
  // contradicted the dock/dialog meter, which reads `policy ?? base` live.
  const barPolicy = useMemo((): MergedPolicy => {
    const c = draft.config ?? {}
    if (previewModel === '') return mergePolicy(c, null)
    const { provider, model } = parseRoute(previewModel)
    const rows = Array.isArray(c.modelPolicies) ? c.modelPolicies : []
    const override = rows.find(p => p.provider === provider && p.model === model) ?? null
    return mergePolicy(c, override)
  }, [draft.config, previewModel])

  // Failure rollback + external-change convergence. The monolithic draft
  // spans every row, so applying must wait until NO write scope is dirty
  // (pending debounce or in-flight write anywhere) — otherwise the server
  // snapshot silently wipes edits still on their way, the same reset-bounce
  // class as the dock's. The epoch guard covers the window where the edit was
  // made in the draft but its debounce timer is not scheduled yet, and the
  // REVISION guard covers the fetch window itself: a snapshot fetched before
  // some write committed is pre-write truth and must be discarded — the loop
  // re-reads the revision at apply time and restarts instead. The loop is
  // single-instance (concurrent failure paths coalesce) and bounded; a patho-
  // logically busy session eventually surfaces through the revision watcher.
  const reseedState = useRef({ running: false, again: false, disposed: false })
  // Retries must die with the page: the loop is detached async work, and a
  // persistently failing remote otherwise keeps it fetching long after
  // unmount (observed: calls kept growing from 2 to 16 after the page was
  // gone). A remount gets a fresh ref object, so the flag cannot wedge.
  useEffect(() => {
    reseedState.current.disposed = false
    return () => { reseedState.current.disposed = true }
  }, [])
  const reseedFromServer = (): void => {
    const state = reseedState.current
    if (state.disposed) return
    if (state.running) {
      state.again = true
      return
    }
    state.running = true
    void (async () => {
      try {
        for (let iteration = 0; iteration < 10; iteration += 1) {
          if (state.disposed) break
          state.again = false
          let lastEpoch = -1
          let stableRounds = 0
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const epoch = draft.epoch()
            if (!anyScopeDirty() && epoch === lastEpoch) {
              stableRounds += 1
              // Two consecutive quiet-and-stable rounds (~500ms) mean the user
              // stopped editing and every scheduled write has drained.
              if (stableRounds >= 2) break
            } else {
              stableRounds = 0
              lastEpoch = epoch
            }
            await new Promise(resolve => setTimeout(resolve, 250))
          }
          const epochAtFetch = draft.epoch()
          const revisionAtFetch = configRevision.getSnapshot()
          try {
            const fresh = await withTimeout(remoteHandle().describe())
            if (!fresh.ok) {
              // A failed fetch proves nothing about convergence: newer
              // revisions may already be waiting (state.again) and dropping
              // out here would lose them permanently — the revision watcher
              // never refires because it already consumed the bump. Mark the
              // cycle unfinished and retry on the next iteration; the rate
              // is bounded by the quiet-wait plus the spacing sleep below.
              state.again = true
              await new Promise(resolve => setTimeout(resolve, 2000))
              continue
            }
            if (!anyScopeDirty()
              && draft.epoch() === epochAtFetch
              && configRevision.getSnapshot() === revisionAtFetch
              && !state.again) {
              draft.reseed(fresh.value.config)
              if (!state.again) return
            }
            // Dirty/epoch/revision moved while the fetch was in flight: the
            // snapshot may predate a write — discard and restart the cycle.
            // Retrying is mandatory, not optional: the movement that caused
            // the discard does not guarantee another cycle trigger — a
            // FAILED write in another scope settles dirty-free without any
            // revision bump, and the revision watcher already consumed the
            // bump this cycle exists for. Exiting here left the UI stuck on
            // the old value with the server already updated.
            state.again = true
          } catch {
            // A THROWN fetch (timeout, dead remote) is the same unknown-
            // convergence situation as `!fresh.ok`: breaking here would
            // leave the very revision this cycle exists to apply permanently
            // unapplied — the watcher already consumed the bump and never
            // refires. Retry with the same pacing; the optimistic draft is
            // untouched either way.
            state.again = true
            await new Promise(resolve => setTimeout(resolve, 2000))
          }
          if (!state.again) break
        }
      } finally {
        state.running = false
        if (state.disposed) {
          state.again = false
        } else if (state.again) {
          // The iteration budget ran out mid-convergence (persistent churn
          // or a stubborn failure streak). Requeueing one more cycle is the
          // only way the newest revision is not silently dropped; each cycle
          // is self-paced by its quiet-waits, so this cannot hot-loop.
          state.again = false
          setTimeout(() => { reseedFromServer() }, 1000)
        }
      }
    })()
  }

  // External convergence: EVERY successful write bumps the config revision —
  // writes from the dock, the dialog, another settings instance, or a host
  // remount. Without this watcher the page kept showing its stale draft until
  // a write of its own failed. Own writes reseed too; applied only when the
  // draft is already quiet, they are no-op confirmations of the same truth.
  const revision = useConfigRevision()
  const seenRevision = useRef(revision)
  useEffect(() => {
    if (describe.state.status !== 'ready') return
    if (seenRevision.current === revision) return
    seenRevision.current = revision
    reseedFromServer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, describe.state])

  const applyGlobal = (patchObj: Record<string, unknown>) => {
    if (draft.config === null) return
    // Functional update against the LATEST draft: rapid edits to different
    // fields in one render batch must compose, not overwrite each other via a
    // stale `draft.config` closure.
    draft.setConfig(prev => {
      if (prev === null) return prev
      const next: Record<string, unknown> = { ...prev }
      for (const [key, value] of Object.entries(patchObj)) {
        if (value === null) delete next[key]
        else next[key] = value
      }
      return next as CompactConfig
    })
    debounce(GLOBAL_SCOPE, patchObj, {
      // One remote write for the merged patch; `begin`/`settle` pair exactly
      // once per submitter even when several callers' edits merge into one
      // wire write — otherwise an earlier caller stays stuck in "saving" on
      // success, or keeps its rolled-forward edit after a merged failure.
      commit: async (pending) => {
        const result = await withTimeout(remoteHandle().patchGlobal(pending))
        if (!result.ok) throw new Error(result.error?.message ?? 'error')
        bumpConfigRevision()
      },
      begin: () => { draft.begin() },
      settle: (err) => {
        draft.mutate(err)
        if (err !== undefined) void reseedFromServer()
      },
    })
  }

  const patch = (key: keyof CompactConfig, value: unknown) => applyGlobal({ [key]: value })

  const applyPolicy = (provider: string, model: string, patchObj: Record<string, unknown>) => {
    if (draft.config === null) return
    draft.setConfig(prev => {
      if (prev === null) return prev
      const policies = (prev.modelPolicies ?? []).map(p => ({ ...p }))
      const index = policies.findIndex(p => p.provider === provider && p.model === model)
      const target: Record<string, unknown> = index < 0
        ? { provider, model }
        : { ...(policies[index] as unknown as Record<string, unknown>) }
      for (const [key, value] of Object.entries(patchObj)) {
        if (value === null) delete target[key]
        else target[key] = value
      }
      const hasFields = Object.keys(target).some(k => k !== 'provider' && k !== 'model')
      if (!hasFields) {
        // Host deletes the row when the last field is removed; mirror that
        // optimistically so ⟲ does not leave an "inherit" ghost row behind.
        if (index >= 0) policies.splice(index, 1)
      } else if (index < 0) policies.push(target as unknown as ModelPolicyConfig)
      else policies[index] = target as unknown as ModelPolicyConfig
      return { ...prev, modelPolicies: policies.length === 0 ? undefined : policies }
    })
    debounce(policyScope(provider, model), patchObj, {
      commit: async (pending) => {
        const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, pending))
        if (!result.ok) throw new Error(result.error?.message ?? 'error')
        bumpConfigRevision()
      },
      begin: () => { draft.begin() },
      settle: (err) => {
        draft.mutate(err)
        if (err !== undefined) void reseedFromServer()
      },
    })
  }

  const policyPatch = (provider: string, model: string, key: string, value: unknown) =>
    applyPolicy(provider, model, { [key]: value })

  const removePolicy = (provider: string, model: string) => {
    // Optimistic removal: the host writes every preset sequentially, so the
    // wire reply can take seconds. Show the row gone immediately.
    draft.setConfig(prev => {
      if (prev === null) return prev
      const remaining = (prev.modelPolicies ?? []).filter(
        p => !(p.provider === provider && p.model === model),
      )
      return { ...prev, modelPolicies: remaining.length === 0 ? undefined : remaining }
    })
    // A field write still waiting on its timer would upsert the row straight
    // back (host setModelPolicy is an upsert). Drop those, then enqueue the
    // removal on the same serial chain so it lands after in-flight writes.
draft.begin()
    void debounce.enqueueWrite(policyScope(provider, model), async () => {
      try {
        const result = await withTimeout(remoteHandle().removeModelPolicy(provider, model))
        draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
        if (result.ok) bumpConfigRevision()
        else void reseedFromServer()
      } catch (error) {
        draft.mutate(error instanceof Error ? error.message : String(error))
        void reseedFromServer()
      }
    })
  }

  const mergedGlobal = useMemo((): MergedPolicy => mergePolicy(draft.config ?? {}, null), [draft.config])

  if (describe.state.status === 'loading') return <div style={{ padding: 24 }}>…</div>
  if (describe.state.status === 'error') {
    return <div style={{ padding: 24, color: '#f7768e' }}>{t('load.error', { message: describe.state.error.message })}</div>
  }
  if (ready !== null && !ready.available) {
    return <div style={{ padding: 24 }}>{t('unavailable')}</div>
  }

  const modelOptions = (catalog.state.status === 'ready' ? catalog.state.value.providers : [])
    .flatMap(p => (catalog.state.status === 'ready' ? catalog.state.value.models[p.id] ?? [] : [])
      .map(m => ({ value: `${p.id}/${m.model}`, label: `${p.id}/${m.name}` })))

  const previewWindow = preview.state.status === 'ready' ? preview.state.value?.contextWindow : undefined

  return (
    <div style={{ maxWidth: '100%', minWidth: 0, padding: '8px 4px 40px' }}>
      <h2 style={{ margin: '4px 0 2px' }}>{t('title')}</h2>
      <p style={{ fontSize: 12, opacity: 0.65, margin: '0 0 4px' }}>{t('page.subtitle')}</p>
      <SaveStatus saving={draft.saving} error={draft.error} savedAt={draft.savedAt} t={t} />

      <div style={card}>
        <div style={sectionTitle}>{t('global.title')}</div>
        <div style={sectionSub}>{t('global.subtitle')}</div>
        <div style={row}>
          <span style={labelCell}>{t('auto.label')}</span>
          <Check
            checked={draft.config?.auto ?? DEFAULTS.auto}
            onChange={v => { patch('auto', v) }}
            label={t('auto.description')}
          />
        </div>
        <PolicyEditor
          config={draft.config ?? {}}
          base={mergedGlobal}
          override={false}
          catalog={catalog.state.status === 'ready' ? catalog.state.value : null}
          t={t}
          onField={(key, value) => { patch(key, value) }}
          onFields={p => { applyGlobal(p) }}
          contextWindow={previewWindow}
          reserveTokens={reserve}
          routePolicy={barPolicy}
          capsPending={previewWindow === undefined && preview.state.status === 'loading'}
        />
      </div>

      <div style={card}>
        <div style={sectionTitle}>{t('bar.title')}</div>
        <div style={row}>
          <span style={labelCell}>{t('f.model')}</span>
          <Select
            value={previewModel}
            options={modelOptions}
            placeholder={t('select.model')}
            onChange={setPreviewModel}
          />
          <ReserveField value={reserve} t={t} onChange={setReserveTokens} />
        </div>
        {previewWindow !== undefined && previewWindow > 0 && (
          <BudgetBar
            contextWindow={previewWindow}
            thresholdRatio={barPolicy.thresholdRatio}
            headroomTokens={barPolicy.headroomTokens}
            retainRatio={barPolicy.retainRatio}
            retainTokens={barPolicy.retainTokens}
            reserveTokens={reserve}
            t={t}
          />
        )}
      </div>

      <div style={card}>
        <div style={sectionTitle}>{t('policies.title')}</div>
        <div style={sectionSub}>{t('policies.subtitle')}</div>
        <PolicyList
          config={draft.config}
          mergedGlobal={mergedGlobal}
          catalog={catalog.state.status === 'ready' ? catalog.state.value : null}
          t={t}
          onField={policyPatch}
          onFields={(p, m, fields) => { applyPolicy(p, m, fields) }}
          onRemove={removePolicy}
          onAdd={(provider, model) => {
            // Optimistic: mirror the empty {provider, model} row the host
            // creates, so the list shows it immediately. The success path
            // never re-seeds the draft (single-source-of-truth), so without
            // this the new row stayed invisible until a page remount.
            draft.setConfig(prev => {
              if (prev === null) return prev
              const policies = [...(prev.modelPolicies ?? [])]
              if (!policies.some(p => p.provider === provider && p.model === model)) {
                policies.push({ provider, model })
              }
              return { ...prev, modelPolicies: policies }
            })
            // Create must not interleave with stale deletions: a pending
            // null-patch from a ⟲ burst (host drops the row once empty) would
            // otherwise fire AFTER this create and delete the row right back.
draft.begin()
            void debounce.enqueueWrite(policyScope(provider, model), async () => {
              try {
                const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, {}))
                draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
                if (result.ok) bumpConfigRevision()
                else void reseedFromServer()
              } catch (error) {
                draft.mutate(error instanceof Error ? error.message : String(error))
                void reseedFromServer()
              }
            })
          }}
          modelOptions={modelOptions}
          reserveTokens={reserve}
        />
      </div>

      <p style={{ fontSize: 11, opacity: 0.5 }}>{t('reloadHint')}</p>
    </div>
  )
}

/**
 * Per-row editor wrapper: the token slider caps must respect THIS row's
 * context window, which differs per model. Without it the override editors
 * fell back to the static caps (retainTokens up to 131072) and happily saved
 * values the engine rejects at runtime for that route — the same class the
 * global editor's routePolicy fix closed, one row at a time. The merge
 * itself stays row-internal: base is the global resolution and config is
 * the row, which is exactly the route merge the engine performs, so no
 * routePolicy prop is needed here.
 */
function RowPolicyEditor(props: {
  policy: ModelPolicyConfig
  mergedGlobal: MergedPolicy
  catalog: CatalogResult | null
  reserveTokens: number
  t: Translator
  onField(key: string, value: unknown): void
  onFields(patch: Record<string, unknown>): void
}): JSX.Element {
  const { policy, t } = props
  const info = useRemote<ModelInfoResult | null>(async () => {
    return remoteHandle().modelInfo(policy.provider, policy.model)
  }, [policy.provider, policy.model])
  const contextWindow = info.state.status === 'ready' ? info.state.value?.contextWindow : undefined
  return (
    <PolicyEditor
      config={policy}
      base={props.mergedGlobal}
      override
      catalog={props.catalog}
      t={t}
      onField={props.onField}
      onFields={props.onFields}
      contextWindow={contextWindow}
      reserveTokens={props.reserveTokens}
      capsPending={info.state.status === 'loading'}
    />
  )
}

/** Per-row delete button with the runtime-invariant gate: deleting the row
 * collapses the route to pure inheritance. When the route's window is known
 * the inherited budget is exactly evaluable — if the engine would reject it
 * at runtime the delete is disabled rather than silently writing a broken
 * route. Removal waits while the window query is pending; if it finishes
 * without a window, the edit falls back to static validation. */
function RowRemoveButton(props: {
  provider: string
  model: string
  mergedGlobal: MergedPolicy
  reserveTokens: number
  t: Translator
  onRemove(provider: string, model: string): void
}): JSX.Element {
  const info = useRemote<ModelInfoResult | null>(async () => {
    return remoteHandle().modelInfo(props.provider, props.model)
  }, [props.provider, props.model])
  const contextWindow = info.state.status === 'ready' ? info.state.value?.contextWindow : undefined
  // An empty row object is exactly the post-delete state: every key inherits.
  const blocked = clearViolatesRuntimeInvariant(contextWindow, props.reserveTokens, 'headroomTokens', {}, props.mergedGlobal)
  const pending = info.state.status === 'loading'
  const disabled = blocked || pending
  return (
    <button
      style={btnDanger}
      disabled={disabled}
      title={blocked ? props.t('policies.removeBlocked') : pending ? props.t('policies.removePending') : undefined}
      onClick={() => { props.onRemove(props.provider, props.model) }}
    >{props.t('policies.remove')}</button>
  )
}

function PolicyList(props: {
  config: CompactConfig | null
  mergedGlobal: MergedPolicy
  catalog: CatalogResult | null
  reserveTokens: number
  t: Translator
  onField(provider: string, model: string, key: string, value: unknown): void
  onFields(provider: string, model: string, patch: Record<string, unknown>): void
  onRemove(provider: string, model: string): void
  onAdd(provider: string, model: string): void
  modelOptions: Array<{ value: string; label: string }>
}): JSX.Element {
  const { t } = props
  // `modelPolicies` can be a `!!js` expression (`__jsExpr` marker object)
  // rather than a literal array — the engine evaluates it at load time, but
  // the UI cannot. Treat non-arrays as an empty list instead of crashing the
  // whole settings page; row-level edits to expression arrays are rejected
  // host-side with a descriptive error.
  const rawPolicies = props.config?.modelPolicies
  const policies = Array.isArray(rawPolicies) ? rawPolicies : []
  const [adding, setAdding] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const used = new Set(policies.map(p => `${p.provider}/${p.model}`))
  const free = props.modelOptions.filter(o => !used.has(o.value))

  return (
    <div>
      {policies.length === 0 && <p style={{ fontSize: 12, opacity: 0.6 }}>{t('policies.empty')}</p>}
      {policies.map(policy => {
        const key = `${policy.provider}/${policy.model}`
        const open = expanded === key
        const overridden = Object.keys(policy).filter(k => k !== 'provider' && k !== 'model' && (policy as unknown as Record<string, unknown>)[k] !== undefined)
        return (
          <div key={key} style={{ borderTop: '1px solid rgba(127,127,127,0.15)', padding: '6px 0' }}>
            <div style={row}>
              <span style={{ flex: '1 1 240px', fontSize: 12, overflowWrap: 'anywhere' }}>
                <strong>{key}</strong>
                <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.55 }}>
                  {overridden.length === 0 ? t('policies.inherit') : `${t('policies.custom')}: ${overridden.join(', ')}`}
                </span>
                {summarizationIssue(policy, props.catalog) !== null && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#e0af68' }}>⚠ {t('health.badge')}</span>
                )}
              </span>
              <button style={btnPrimary} onClick={() => { setExpanded(open ? null : key) }}>{t('policies.edit')}</button>
              <RowRemoveButton
                provider={policy.provider}
                model={policy.model}
                mergedGlobal={props.mergedGlobal}
                reserveTokens={props.reserveTokens}
                t={t}
                onRemove={props.onRemove}
              />
            </div>
            {open && (
              <RowPolicyEditor
                policy={policy}
                mergedGlobal={props.mergedGlobal}
                catalog={props.catalog}
                reserveTokens={props.reserveTokens}
                t={t}
                onField={(field, value) => { props.onField(policy.provider, policy.model, field, value) }}
                onFields={fields => { props.onFields(policy.provider, policy.model, fields) }}
              />
            )}
          </div>
        )
      })}
      {free.length > 0 && (
        <div style={row}>
          <Select
            value={adding}
            options={free}
            placeholder={t('policies.add')}
            onChange={setAdding}
          />
          <button
            style={btnPrimary}
            disabled={adding === ''}
            onClick={() => {
              const { provider, model } = parseRoute(adding)
              if (provider !== '' && model !== '') {
                props.onAdd(provider, model)
                setAdding('')
                setExpanded(adding)
              }
            }}
          >
            {t('policies.add')}
          </button>
        </div>
      )}
    </div>
  )
}
