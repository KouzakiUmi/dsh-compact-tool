/** Small uncontrolled-style form controls styled to sit in DSH panels. */

import type { CSSProperties, ReactNode } from 'react'
import { formatTokens } from './format.js'
import type { Translator } from './hooks.js'

export const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0' }
export const labelCell: CSSProperties = { width: 150, flexShrink: 0, fontSize: 12 }
export const hintText: CSSProperties = { fontSize: 11, opacity: 0.55, marginLeft: 160, marginTop: -6, marginBottom: 6 }
export const numInput: CSSProperties = {
  width: 88, padding: '3px 6px', fontSize: 12, borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
}
export const selectStyle: CSSProperties = {
  padding: '3px 6px', fontSize: 12, borderRadius: 4, maxWidth: 240,
  border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
}
export const btn: CSSProperties = {
  padding: '3px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
  border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
}
export const btnPrimary: CSSProperties = { ...btn, borderColor: '#7aa2f7', color: '#7aa2f7' }
export const btnDanger: CSSProperties = { ...btn, borderColor: '#f7768e', color: '#f7768e' }
export const card: CSSProperties = {
  border: '1px solid rgba(127,127,127,0.22)', borderRadius: 8,
  padding: '10px 14px', margin: '12px 0',
}
export const sectionTitle: CSSProperties = { fontSize: 13, fontWeight: 600, margin: '4px 0 2px' }
export const sectionSub: CSSProperties = { fontSize: 11, opacity: 0.6, margin: '0 0 8px' }

export interface SliderFieldProps {
  label: string
  hint?: string | undefined
  value: number
  min: number
  max: number
  step?: number | undefined
  disabled?: boolean | undefined
  /** Visual-only: an inherited field is dimmed but STILL draggable — dragging
      it writes a concrete value and thereby un-inherits it. */
  dimmed?: boolean | undefined
  /** Formats the value readout. */
  format?: ((v: number) => string) | undefined
  onChange(v: number): void
  /** Right-side addon (e.g. an inherit checkbox). */
  extra?: ReactNode
}

export function SliderField(props: SliderFieldProps): JSX.Element {
  const format = props.format ?? formatTokens
  return (
    <div style={{ opacity: props.disabled === true || props.dimmed === true ? 0.5 : 1 }}>
      <div style={row}>
        <span style={labelCell}>{props.label}</span>
        <input
          type="range"
          style={{ flex: 1, minWidth: 80 }}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          disabled={props.disabled}
          onChange={event => { props.onChange(Number(event.target.value)) }}
        />
        <input
          type="number"
          style={numInput}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          disabled={props.disabled}
          onChange={event => {
            // An empty number input must not be parsed as 0 and clamped to min.
            if (event.target.value === '') return
            const next = Number(event.target.value)
            if (Number.isFinite(next)) props.onChange(Math.min(props.max, Math.max(props.min, next)))
          }}
        />
        <span style={{ width: 64, fontSize: 11, fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>
          {format(props.value)}
        </span>
        {props.extra}
      </div>
      {props.hint !== undefined && <div style={hintText}>{props.hint}</div>}
    </div>
  )
}

/** Compact one-line slider for popover-size cards (built-in meter popover style). */
export function MiniSlider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number | undefined
  disabled?: boolean | undefined
  format?: ((v: number) => string) | undefined
  onChange(v: number): void
  extra?: ReactNode
}): JSX.Element {
  const format = props.format ?? formatTokens
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: props.disabled === true ? 0.5 : 1 }}>
      <span style={{ width: 52, flexShrink: 0, fontSize: 11, opacity: 0.85 }}>{props.label}</span>
      <input
        type="range"
        style={{ flex: 1, minWidth: 60, height: 12 }}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        onChange={event => { props.onChange(Number(event.target.value)) }}
      />
      <span style={{ width: 46, fontSize: 11, fontVariantNumeric: 'tabular-nums', opacity: 0.85, textAlign: 'right' }}>
        {format(props.value)}
      </span>
      {props.extra}
    </div>
  )
}

export interface CheckProps {
  checked: boolean
  onChange(v: boolean): void
  label?: string | undefined
  disabled?: boolean | undefined
}

export function Check(props: CheckProps): JSX.Element {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: props.disabled === true ? 'default' : 'pointer' }}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={event => { props.onChange(event.target.checked) }}
      />
      {props.label}
    </label>
  )
}

export interface OptionRow {
  value: string
  label: string
}

export function Select(props: {
  value: string
  options: OptionRow[]
  placeholder?: string | undefined
  disabled?: boolean | undefined
  onChange(v: string): void
}): JSX.Element {
  return (
    <select
      style={selectStyle}
      value={props.value}
      disabled={props.disabled}
      onChange={event => { props.onChange(event.target.value) }}
    >
      {props.placeholder !== undefined && <option value="">{props.placeholder}</option>}
      {props.options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

/** Save-status line shared by the page and the dialog. */
export function SaveStatus(props: { saving: boolean; error: string | null; savedAt: number | null; t: Translator }): JSX.Element {
  const { t } = props
  return (
    <span style={{ fontSize: 11, marginLeft: 8 }}>
      {props.saving && <span style={{ opacity: 0.6 }}>{t('saving')}</span>}
      {props.error !== null && <span style={{ color: '#f7768e' }}>{t('save.error', { message: props.error })}</span>}
      {!props.saving && props.error === null && props.savedAt !== null && (
        <span style={{ opacity: 0.5 }}>{t('saved')}</span>
      )}
    </span>
  )
}
