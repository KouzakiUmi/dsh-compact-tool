/**
 * The compaction budget bar: one horizontal track the width of the context
 * window, drawn like the composer context-pressure widget — colored segments
 * for the live usage breakdown when a session supplies it, a filled "usable
 * budget" area up to the trigger marker otherwise. Two markers ride the bar:
 * the compaction trigger (threshold) and the retain tail; a diamond shows the
 * live projected pressure so users can place the trigger relative to reality.
 */

import type { CSSProperties } from 'react'
import { formatTokens, retainTokens as retainOf, thresholdTokens as thresholdOf } from './format.js'
import type { Translator } from './hooks.js'

export interface LiveBreakdown {
  /** contextPressure.pressureTokens — measured prompt pressure. */
  pressureTokens?: number | undefined
  /** contextPressure.projectedTokens — next-turn projection. */
  projectedTokens?: number | undefined
  /** contextPressure.contextWindow — the session's measured window. */
  contextWindow?: number | undefined
  /** contextBreakdown buckets (heuristic; proportions only). */
  systemTokens?: number | undefined
  toolsTokens?: number | undefined
  messageTokens?: number | undefined
}

export interface BudgetBarProps {
  contextWindow: number
  thresholdRatio: number
  headroomTokens: number
  retainRatio: number
  /** Fixed retention when set, including zero. */
  retainTokens: number | undefined
  /** Assumed per-request output reservation (slider-owned preview value). */
  reserveTokens: number
  live?: LiveBreakdown | undefined
  t: Translator
}

const TRACK_HEIGHT = 14
const SEG_COLORS = {
  system: '#7aa2f7',
  tools: '#bb9af7',
  messages: '#73daca',
  budget: 'rgba(122, 162, 247, 0.28)',
  headroom: 'rgba(255, 255, 255, 0.08)',
  reserve: 'rgba(255, 158, 100, 0.35)',
} as const

export function BudgetBar(props: BudgetBarProps): JSX.Element {
  const { contextWindow: W, t } = props
  const threshold = thresholdOf(W, props.thresholdRatio, props.headroomTokens, props.reserveTokens)
  const retain = retainOf(W, props.reserveTokens, props.retainRatio, props.retainTokens)
  const live = props.live
  const used = live?.pressureTokens ?? 0
  const projected = live?.projectedTokens ?? used

  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / W) * 100)).toFixed(3)}%`

  // Live: colored breakdown scaled to `used`; idle: plain budget fill to the trigger.
  const breakdownTotal = (live?.systemTokens ?? 0) + (live?.toolsTokens ?? 0) + (live?.messageTokens ?? 0)
  const segments: Array<{ key: string; color: string; width: number }> =
    live !== undefined && used > 0 && breakdownTotal > 0
      ? [
        { key: 'system', color: SEG_COLORS.system, width: used * (live.systemTokens ?? 0) / breakdownTotal },
        { key: 'tools', color: SEG_COLORS.tools, width: used * (live.toolsTokens ?? 0) / breakdownTotal },
        { key: 'messages', color: SEG_COLORS.messages, width: used * (live.messageTokens ?? 0) / breakdownTotal },
      ].filter(segment => segment.width > 0)
      : [{ key: 'budget', color: SEG_COLORS.budget, width: Math.max(0, threshold) }]

  const track: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: TRACK_HEIGHT,
    borderRadius: 4,
    overflow: 'visible',
    background: 'rgba(127, 127, 127, 0.12)',
    display: 'flex',
  }

  const marker = (left: number, color: string, label: string, below: boolean): JSX.Element => (
    <div
      key={label}
      title={`${label}: ${formatTokens(left)}`}
      style={{
        position: 'absolute',
        left: pct(left),
        top: below ? TRACK_HEIGHT : -2,
        transform: 'translateX(-50%)',
        width: 0,
        height: 0,
        borderLeft: '5px solid transparent',
        borderRight: '5px solid transparent',
        ...(below
          ? { borderTop: `5px solid ${color}` }
          : { borderBottom: `5px solid ${color}` }),
      }}
    />
  )

  const legendRow = (label: string, value: string, color?: string): JSX.Element => (
    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12 }}>
      {color !== undefined && <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />}
      <span style={{ opacity: 0.75 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </span>
  )

  const freeToHeadroom = W - props.reserveTokens - props.headroomTokens - used

  return (
    <div style={{ padding: '10px 6px 4px' }}>
      <div style={track} role="img" aria-label={`${formatTokens(used)} / ${formatTokens(W)}`}>
        {segments.map(segment => (
          <div
            key={segment.key}
            style={{
              width: pct(segment.width),
              height: '100%',
              background: segment.color,
              minWidth: segment.width > 0 ? 1 : 0,
            }}
          />
        ))}
        {/* output-reserve + headroom shades at the window tail */}
        <div style={{
          position: 'absolute',
          right: 0,
          width: pct(props.headroomTokens + props.reserveTokens),
          height: '100%',
          display: 'flex',
          pointerEvents: 'none',
        }}>
          <div style={{ flex: props.headroomTokens, background: SEG_COLORS.headroom }} />
          <div style={{ flex: props.reserveTokens, background: SEG_COLORS.reserve }} />
        </div>
        {threshold > 0 && marker(threshold, '#e0af68', `▲ ${t('bar.threshold')} ${formatTokens(threshold)}`, false)}
        {retain > 0 && marker(retain, '#9ece6a', `▼ ${t('bar.retain')} ${formatTokens(retain)}`, true)}
        {live !== undefined && projected > 0 && (
          <div
            title={`${t('bar.projected')}: ${formatTokens(projected)}`}
            style={{
              position: 'absolute',
              left: pct(projected),
              top: -7,
              transform: 'translateX(-50%) rotate(45deg)',
              width: 7,
              height: 7,
              background: '#ff9e64',
              border: '1px solid rgba(0,0,0,0.4)',
            }}
          />
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, fontSize: 11, marginTop: 10, lineHeight: 1.7 }}>
        {legendRow(t('bar.window'), formatTokens(W))}
        {live !== undefined
          ? <>
            {legendRow(t('bar.seg.system'), formatTokens(live.systemTokens ?? 0), SEG_COLORS.system)}
            {legendRow(t('bar.seg.tools'), formatTokens(live.toolsTokens ?? 0), SEG_COLORS.tools)}
            {legendRow(t('bar.seg.messages'), formatTokens(live.messageTokens ?? 0), SEG_COLORS.messages)}
            {legendRow(t('bar.live'), formatTokens(used))}
            {legendRow(t('bar.projected'), formatTokens(projected), '#ff9e64')}
            {legendRow(t('bar.seg.free'), formatTokens(Math.max(0, freeToHeadroom)))}
          </>
          : legendRow(t('bar.used'), `0 → ${formatTokens(threshold)}`)}
        {legendRow(t('bar.threshold'), `${formatTokens(threshold)} (${Math.round(props.thresholdRatio * 100)}%)`, '#e0af68')}
        {legendRow(t('bar.retain'), formatTokens(retain), '#9ece6a')}
        {legendRow(t('bar.headroom'), formatTokens(props.headroomTokens), SEG_COLORS.headroom)}
        {legendRow(t('bar.reserve'), formatTokens(props.reserveTokens), SEG_COLORS.reserve)}
      </div>
    </div>
  )
}
