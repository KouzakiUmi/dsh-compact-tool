/**
 * The `settings.section` page: global policy editor + budget-bar preview +
 * the list of per-model overrides. Every field write debounces into one
 * `patchGlobal`/`setModelPolicy` wire call per control burst; the returned
 * config re-seeds the draft so the UI mirrors the profile patch.
 */

import { useEffect, useMemo, useState } from 'react'
import { remoteHandle } from './remote.js'
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
import type {
  CatalogResult,
  CompactConfig,
  DescribeResult,
  EffectiveResult,
  ModelInfoResult,
  ModelPolicyConfig,
} from '../shared.js'
import { DEFAULTS, resolveRetention, type MergedPolicy } from '../shared.js'

export interface SettingsPageProps {
  close(): void
  t: Translator
}

const PREVIEW_RESERVE_DEFAULT = 8192

export function SettingsPage(props: SettingsPageProps): JSX.Element {
  const { t } = props
  const describe = useRemote<DescribeResult>(() => remoteHandle().describe(), [])
  const catalog = useRemote<CatalogResult>(() => remoteHandle().catalog(), [])
  const [previewModel, setPreviewModel] = useState('')
  const [reserve, setReserve] = useState(PREVIEW_RESERVE_DEFAULT)

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

  // The budget bar must reflect the previewed route's OVERRIDE too, not just
  // the global row — otherwise the preview contradicts the dock/dialog meter.
  const previewEffective = useRemote<EffectiveResult | null>(async () => {
    if (previewModel === '') return { ok: true, value: null }
    const { provider, model } = parseRoute(previewModel)
    return remoteHandle().effectiveFor(provider, model)
  }, [previewModel])
  const previewMerged = previewEffective.state.status === 'ready' ? previewEffective.state.value?.merged : undefined

  // Failure rollback: pull fresh server truth into the draft. The optimistic
  // draft is authoritative on success; only a failed write re-seeds it.
  const reseedFromServer = async (): Promise<void> => {
    try {
      const fresh = await withTimeout(remoteHandle().describe())
      if (fresh.ok) draft.reseed(fresh.value.config)
    } catch { /* keep the optimistic draft; the error is already surfaced */ }
  }

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
    debounce('global:', patchObj, async (pending) => {
      draft.begin()
      try {
        const result = await withTimeout(remoteHandle().patchGlobal(pending))
        draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
        if (!result.ok) void reseedFromServer()
      } catch (error) {
        draft.mutate(error instanceof Error ? error.message : String(error))
        void reseedFromServer()
      }
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
    debounce(`policy:${provider}/${model}:`, patchObj, async (pending) => {
      draft.begin()
      try {
        const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, pending))
        draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
        if (!result.ok) void reseedFromServer()
      } catch (error) {
        draft.mutate(error instanceof Error ? error.message : String(error))
        void reseedFromServer()
      }
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
    debounce.cancelByPrefix(`policy:${provider}/${model}:`)
    draft.begin()
    void debounce.enqueue(async () => {
      try {
        const result = await withTimeout(remoteHandle().removeModelPolicy(provider, model))
        draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
        if (!result.ok) void reseedFromServer()
      } catch (error) {
        draft.mutate(error instanceof Error ? error.message : String(error))
        void reseedFromServer()
      }
    })
  }

  const mergedGlobal = useMemo((): MergedPolicy => {
    const c = draft.config ?? {}
    const headroom = c.headroomTokens ?? DEFAULTS.headroomTokens
    const retention = resolveRetention(c)
    return {
      thresholdRatio: c.thresholdRatio ?? DEFAULTS.thresholdRatio,
      headroomTokens: headroom,
      retainRatio: retention.retainRatio ?? DEFAULTS.retainRatio,
      ...retention,
      summarizationProvider: c.summarizationProvider ?? '',
      summarizationModel: c.summarizationModel ?? '',
      maxTokens: c.maxTokens ?? headroom,
      compactionRetries: c.compactionRetries ?? DEFAULTS.compactionRetries,
      maxOverflowRetries: c.maxOverflowRetries ?? DEFAULTS.maxOverflowRetries,
    }
  }, [draft.config])

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
  const barPolicy = previewMerged ?? mergedGlobal

  return (
    <div style={{ maxWidth: 860, padding: '8px 4px 40px' }}>
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
          <ReserveField value={reserve} t={t} onChange={setReserve} />
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
            draft.begin()
            void debounce.enqueue(async () => {
              try {
                const result = await withTimeout(remoteHandle().setModelPolicy(provider, model, {}))
                draft.mutate(result.ok ? undefined : (result.error?.message ?? 'error'))
                if (!result.ok) void reseedFromServer()
              } catch (error) {
                draft.mutate(error instanceof Error ? error.message : String(error))
                void reseedFromServer()
              }
            })
          }}
          modelOptions={modelOptions}
        />
      </div>

      <p style={{ fontSize: 11, opacity: 0.5 }}>{t('reloadHint')}</p>
    </div>
  )
}

function PolicyList(props: {
  config: CompactConfig | null
  mergedGlobal: MergedPolicy
  catalog: CatalogResult | null
  t: Translator
  onField(provider: string, model: string, key: string, value: unknown): void
  onFields(provider: string, model: string, patch: Record<string, unknown>): void
  onRemove(provider: string, model: string): void
  onAdd(provider: string, model: string): void
  modelOptions: Array<{ value: string; label: string }>
}): JSX.Element {
  const { t } = props
  const policies = props.config?.modelPolicies ?? []
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
              <span style={{ flex: 1, fontSize: 12 }}>
                <strong>{key}</strong>
                <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.55 }}>
                  {overridden.length === 0 ? t('policies.inherit') : `${t('policies.custom')}: ${overridden.join(', ')}`}
                </span>
                {summarizationIssue(policy, props.catalog) !== null && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#e0af68' }}>⚠ {t('health.badge')}</span>
                )}
              </span>
              <button style={btnPrimary} onClick={() => { setExpanded(open ? null : key) }}>{t('policies.edit')}</button>
              <button style={btnDanger} onClick={() => { props.onRemove(policy.provider, policy.model) }}>{t('policies.remove')}</button>
            </div>
            {open && (
              <PolicyEditor
                config={policy}
                base={props.mergedGlobal}
                override
                catalog={props.catalog}
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
