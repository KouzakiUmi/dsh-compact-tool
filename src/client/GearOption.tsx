/**
 * The gear entry appended inside the model-selector menu
 * (`conversation.input.model.options`, session scope). Secondary entry to
 * the policy dialog — the primary one is the composer-dock button rendered
 * beside the built-in context meter. Clicking dismisses the menu and opens
 * the dialog through the dialog channel, carrying this session's
 * `useProjection` so the dialog renders the live pressure monitor bar.
 */

import { formatTokens } from './format.js'
import type { Translator } from './hooks.js'
import { requestDockPopover } from './dialog.js'
import { useModelRoute, type ContextPressureView, type UseProjection } from './sessionKit.js'

export interface GearOptionProps {
  locked?: boolean | undefined
  dismiss(): void
  reportFailure?(message: string): void
  useProjection?: UseProjection | undefined
  sessionId: string
  t: Translator
}

export function GearOption(props: GearOptionProps): JSX.Element | null {
  const { useProjection, t } = props
  // Hooks must run unconditionally: useProjection is standard on this seat,
  // but exotic mounts may omit it — guard AFTER the calls, never return null
  // before hooks.
  const route = useModelRoute(useProjection)
  const pressure = useProjection?.('contextPressure') as ContextPressureView | undefined
  if (useProjection === undefined) return null

  const enabled = props.locked !== true && route !== undefined
  const projected = pressure?.projectedTokens ?? pressure?.pressureTokens
  const summary = projected !== undefined && pressure?.contextWindow !== undefined
    ? `${formatTokens(projected)}/${formatTokens(pressure.contextWindow)}`
    : undefined

  const open = () => {
    if (!enabled || route === undefined) return
    props.dismiss()
    // Same-fiber handoff: the dock meter owns the live popover; this menu
    // seat cannot mount overlays, so it drops a focus request on the channel.
    requestDockPopover(props.sessionId)
  }

  return (
    <div
      role="button"
      tabIndex={enabled ? 0 : -1}
      title={route === undefined ? t('dock.noModel') : t('gear.description')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        fontSize: 12,
        cursor: enabled ? 'pointer' : 'default',
        borderTop: '1px solid rgba(127,127,127,0.15)',
        opacity: enabled ? 1 : 0.45,
      }}
      onClick={open}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
    >
      <span aria-hidden>⚙</span>
      <span style={{ flex: 1 }}>{t('gear.label')}</span>
      {summary !== undefined && (
        <span style={{ fontSize: 11, opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}>{summary}</span>
      )}
    </div>
  )
}
