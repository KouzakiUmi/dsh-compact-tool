/**
 * The shared policy field editor. In global mode every field writes directly;
 * in override mode each field gets an "inherit" checkbox — an unchecked field
 * rides the global/base value and is written as `null` (deleted) so the merge
 * falls through, exactly like compaction-basic's per-key ?? resolution.
 */

import { btn, Check, Select, SliderField, hintText, row, labelCell, numInput } from './controls.tsx'
import type { Translator } from './hooks.js'
import { formatTokens, ratioSliderBounds } from './format.js'
import { summarizationIssue } from './health.js'
import { resolveRetention, type CatalogResult, type CompactConfig, type MergedPolicy, type PolicyFields } from '../shared.js'

export interface PolicyEditorProps {
  /** Current values of the row being edited (raw; undefined = unset). */
  config: CompactConfig
  /** Base values to inherit/preview (global merged with defaults). */
  base: MergedPolicy
  /** true ⇒ per-field inherit checkboxes (per-model policy row). */
  override: boolean
  catalog: CatalogResult | null
  t: Translator
  /** Patch one field; value null clears it (override mode → inherit). */
  onField(key: keyof PolicyFields, value: unknown | null): void
  /** Patch several keys in ONE wire write (summarization pair, retain exclusivity). */
  onFields(patch: Record<string, unknown>): void
}

interface FieldDef {
  key: keyof PolicyFields
  label: string
  hint?: string
  min: number
  max: number
  step: number
  format?: ((v: number) => string) | undefined
}

const RATIO_FORMAT = (v: number) => `${Math.round(v * 100)}%`

const NUMERIC_FIELDS: FieldDef[] = [
  { key: 'thresholdRatio', label: 'f.thresholdRatio', hint: 'f.thresholdRatio.hint', min: 0.4, max: 0.95, step: 0.01, format: RATIO_FORMAT },
  { key: 'headroomTokens', label: 'f.headroomTokens', hint: 'f.headroomTokens.hint', min: 1024, max: 262144, step: 1024 },
  { key: 'retainRatio', label: 'f.retainRatio', hint: 'f.retainRatio.hint', min: 0.02, max: 0.6, step: 0.01, format: RATIO_FORMAT },
  // 0 is NOT "use the ratio" for the engine: retainTokens:0 means keep zero
  // verbatim tokens. Keep the slider away from 0; the inherit checkbox clears
  // the key instead.
  { key: 'retainTokens', label: 'f.retainTokens', hint: 'f.retainTokens.hint', min: 1024, max: 131072, step: 1024 },
  { key: 'maxTokens', label: 'f.maxTokens', hint: 'f.maxTokens.hint', min: 1024, max: 262144, step: 1024 },
  { key: 'compactionRetries', label: 'f.compactionRetries', hint: 'f.compactionRetries.hint', min: 0, max: 5, step: 1, format: v => String(v) },
  { key: 'maxOverflowRetries', label: 'f.maxOverflowRetries', hint: 'f.maxOverflowRetries.hint', min: 0, max: 5, step: 1, format: v => String(v) },
]

function effectiveNumber(config: PolicyFields, base: MergedPolicy, key: keyof PolicyFields): number {
  const own = config[key]
  if (typeof own === 'number') return own
  const inherited = base[key]
  return typeof inherited === 'number' ? inherited : 0
}

export function PolicyEditor(props: PolicyEditorProps): JSX.Element {
  const { config, base, override, t } = props
  const retention = resolveRetention(override ? base : config, override ? config : undefined)
  const bounds = ratioSliderBounds(override ? base : config, override ? config : undefined)

  /**
   * The engine rejects a config carrying BOTH retainRatio and retainTokens
   * (`resolveConfig`: "mutually exclusive"), so writing one always clears the
   * other in the same wire write.
   */
  const writeField = (key: keyof PolicyFields, value: unknown): void => {
    if (key === 'retainRatio') props.onFields({ retainRatio: value, retainTokens: null })
    else if (key === 'retainTokens') props.onFields({ retainTokens: value, retainRatio: null })
    else props.onField(key, value)
  }

  /** summarizationProvider/Model must be set as a PAIR — clear both together. */
  const clearField = (key: keyof PolicyFields): void => {
    if (key === 'summarizationProvider' || key === 'summarizationModel') {
      props.onFields({ summarizationProvider: null, summarizationModel: null })
    } else {
      props.onField(key, null)
    }
  }

  const inheritToggle = (key: keyof PolicyFields): JSX.Element | undefined => {
    if (!override) return undefined
    const inherited = config[key] === undefined
    return (
      <Check
        checked={inherited}
        label={t('f.inheritField')}
        onChange={(inherit) => {
          if (inherit) clearField(key)
          else if (key === 'summarizationProvider' || key === 'summarizationModel') {
            // Write an EMPTY PAIR (both ''), not two nulls: deleting both keys
            // leaves them undefined, which the "inherit" checkbox reads as
            // still inherited and keeps the selects disabled. An empty pair is
            // legal for resolveConfig and means "use the session's model".
            props.onFields({
              summarizationProvider: base.summarizationProvider ?? '',
              summarizationModel: base.summarizationModel ?? '',
            })
          } else if (key === 'retainTokens') writeField(key, Math.max(1024, retention.retainTokens ?? 0))
          else if (key === 'retainRatio') writeField(key, Math.min(bounds.retainMax, effectiveNumber(config, base, key)))
          else writeField(key, effectiveNumber(config, base, key))
        }}
      />
    )
  }

  const providerOptions = (props.catalog?.providers ?? []).map(p => ({ value: p.id, label: p.name }))
  const summarizationProvider = config.summarizationProvider ?? ''
  const summarizationModels = summarizationProvider === ''
    ? []
    : (props.catalog?.models[summarizationProvider] ?? [])
  const modelOptions = summarizationModels.map(m => ({ value: m.model, label: m.name }))

  const summarizationDisabled = override && config.summarizationProvider === undefined && config.summarizationModel === undefined

  /**
   * `resolveConfig` requires provider+model as an empty OR non-empty PAIR:
   * `(provider.length === 0) !== (model.length === 0)` is rejected. A lone
   * provider (or provider + empty model) therefore writes an illegal config
   * that prevents compaction-basic from loading at all.
   */
  const setSummarization = (provider: string, model: string): void => {
    const useDefault = provider === '' || model === ''
    props.onFields({
      summarizationProvider: useDefault ? (override ? '' : null) : provider,
      summarizationModel: useDefault ? (override ? '' : null) : model,
    })
  }

  // P1 health check: warn when this row's explicit summarization route is no
  // longer advertised, and offer a one-click clear back to the session model.
  const routeIssue = summarizationIssue(config, props.catalog)

  return (
    <div>
      {NUMERIC_FIELDS.map(field => {
        const min = field.key === 'retainRatio' ? bounds.retainMin
          : field.key === 'thresholdRatio' ? bounds.thresholdMin : field.min
        const max = field.key === 'retainRatio' ? bounds.retainMax
          : field.key === 'thresholdRatio' ? bounds.thresholdMax : field.max
        const effective = field.key === 'retainTokens' ? retention.retainTokens ?? 0 : effectiveNumber(config, base, field.key)
        const value = Math.min(max, effective)
        return (
          <SliderField
            key={field.key}
            label={t(field.label)}
            hint={field.hint === undefined ? undefined : t(field.hint)}
            value={value}
            min={min}
            max={max}
            step={field.key === 'retainRatio' ? Math.min(field.step, max) : field.step}
            format={field.format}
            // Inherited fields stay draggable: dragging one writes a concrete
            // value and the "inherit" checkbox flips off automatically. A
            // hard `disabled` made the slider look broken ("why won't it move").
            dimmed={override && config[field.key] === undefined}
            onChange={v => { writeField(field.key, v) }}
            extra={inheritToggle(field.key)}
          />
        )
      })}

      <div>
        <div style={row}>
          <span style={labelCell}>{t('f.summarization')}</span>
          <Select
            value={summarizationProvider}
            placeholder={t('select.provider')}
            options={providerOptions}
            disabled={summarizationDisabled}
            onChange={v => {
              if (v === '') {
                setSummarization('', '')
              } else {
                const first = (props.catalog?.models[v] ?? [])[0]?.model
                // No advertised model: clear both (an empty pair is legal)
                // instead of writing a lone provider the engine rejects.
                if (first === undefined) setSummarization('', '')
                else setSummarization(v, first)
              }
            }}
          />
          <Select
            value={config.summarizationModel ?? ''}
            placeholder={t('select.model')}
            options={modelOptions}
            disabled={summarizationDisabled || summarizationProvider === ''}
            onChange={v => { v === '' ? setSummarization('', '') : setSummarization(summarizationProvider, v) }}
          />
          {inheritToggle('summarizationProvider')}
        </div>
        <div style={hintText}>{t('f.summarization.hint')}</div>
        {routeIssue !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 160, marginTop: 2, fontSize: 11, color: '#e0af68' }}>
            <span style={{ flex: 1 }}>
              {routeIssue.kind === 'provider-missing'
                ? t('health.providerMissing', { provider: routeIssue.provider })
                : t('health.modelMissing', { provider: routeIssue.provider, model: routeIssue.model })}
            </span>
            <button
              type="button"
              style={{ ...btn, fontSize: 11, padding: '1px 8px', borderColor: '#e0af68', color: '#e0af68', flexShrink: 0 }}
              onClick={() => { setSummarization('', '') }}
            >{t('health.clear')}</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Convenience: a compact numeric-only sub-editor is not needed separately —
 * BudgetBar's assumed reserve rides this tiny inline field. */
export function ReserveField(props: { value: number; t: Translator; onChange(v: number): void }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.85 }}>
      <span>{props.t('bar.reserveField')}</span>
      <input
        type="number"
        style={{ ...numInput, width: 76 }}
        min={0}
        step={1024}
        value={props.value}
        onChange={event => {
          if (event.target.value === '') return
          const next = Number(event.target.value)
          if (Number.isFinite(next) && next >= 0) props.onChange(next)
        }}
      />
      <span style={{ opacity: 0.6 }}>{formatTokens(props.value)}</span>
    </span>
  )
}
