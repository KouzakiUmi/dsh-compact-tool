/**
 * dsh-compact-tool client half. Mounts the `compactTool` Remote namespace,
 * registers the locale dictionaries, the `settings.section` page, the
 * model-selector gear entry, and the `shell.overlay` dialog host.
 */

import type { Context } from '@deepseek-ai/cordis'
import { compactToolRemote, setRemoteHandle } from './remote.js'
import type { ClientRemoteFace, CompactToolCalls } from './remote-types.js'
import { en, NS, zh } from './locales.js'
import { DockEntry } from './DockEntry.tsx'
import { GearOption } from './GearOption.tsx'
import { PolicyDialogHost } from './PolicyDialog.tsx'
import { SettingsPage } from './SettingsPage.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remote: ClientRemoteFace
  }
}

/** Required services: remote mount + slots + locale surface. */
export const inject = ['remote', 'slots', 'locale']

export function apply(ctx: Context): void {
  // Host Remote namespace. $mount resolves asynchronously; the namespace
  // handle becomes visible as `remote.compactTool` once it settles. Slot and
  // locale registration must not wait on it — an async apply that awaits the
  // mount before registering never reaches the slot writes (Cordis does not
  // await the apply return value either).
  const mounted: Promise<(() => Promise<void>) | undefined> =
    Promise.resolve(ctx.remote.$mount(compactToolRemote) as unknown)
      .then(unmount => unmount as (() => Promise<void>) | undefined)
  ctx.effect(async () => {
    try {
      const unmount = await mounted
      try {
        setRemoteHandle((ctx.get('remote.compactTool') ?? ctx.remote.compactTool) as CompactToolCalls)
        console.info('[dsh-compact-tool] remote.compactTool mounted')
      } catch (error) {
        console.error('[dsh-compact-tool] remote.compactTool missing after mount:', error)
      }
      return async () => {
        setRemoteHandle(undefined)
        await unmount?.()
      }
    } catch (error) {
      console.error('[dsh-compact-tool] remote mount failed:', error)
      return () => {/* mount failed: nothing to clean up */}
    }
  }, 'compact-tool: mount remotes')

  // Locales (zh/en; other UI languages fall back to the bundle default).
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'compact-tool: dictionaries')
  const t = ctx.locale.bind(NS)

  // Settings section page.
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'compact-tool',
    order: 70,
    label: () => t('title'),
    locale: NS,
  }, SettingsPage as never)), 'compact-tool: section')

  // Dock entry REPLACES the built-in ContextMeter (it is not enrichable from
  // outside, so we hide it and render the same ring+panel contract ourselves).
  // The hide rule keys on the stock meter's root span: the only dock child
  // carrying a `--dsh-context-*` anchor-name without `data-composer-stat` —
  // StatsPills and our own entry both follow that attribute convention, so a
  // host markup change degrades to two meters, never to a missing meter.
  // The trigger's interactive states (hover / expanded) also live here: they
  // need pseudo-classes, which inline styles cannot express. Values mirror
  // ContextMeter.module.css `.trigger` exactly.
  const STYLE_TEXT =
    "[data-composer-dock] > span[style*='--dsh-context-']:not([data-composer-stat]) { display: none !important; }" +
    ".dsh-compact-trigger:hover, .dsh-compact-trigger[aria-expanded='true'] {" +
    " background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }" +
    ".dsh-compact-trigger:focus-visible { outline: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.5)); outline-offset: 1px; }"
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.compactTool = 'dock-css'
    style.textContent = STYLE_TEXT
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'compact-tool: dock css')

  // Primary entry in the composer footer (session scope), standing in for the
  // stock ContextMeter. order 90 keeps it rightmost: the slot renders before
  // the meter and chat pills sit at order 0/1.
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'compact-tool.dock',
    order: 90,
    locale: NS,
  }, DockEntry as never)), 'compact-tool: dock')

  // Gear entry inside the model selector (session scope).
  ctx.effect(() => ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
    name: 'conversation.input.model.options',
    id: 'compact-tool.model-options',
    locale: NS,
  }, GearOption as never)), 'compact-tool: gear')

  // Overlay host for the per-model dialog (root scope).
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'compact-tool.overlay',
    locale: NS,
  }, PolicyDialogHost as never)), 'compact-tool: overlay')
}

// Do NOT add `export default`: the loader treats a default-exported function
// as the function-form plugin, which has no inject declaration site — the
// fiber then activates with an empty inject set and `ctx.remote` throws
// "cannot get property \"remote\" without inject". Object form (named exports
// only) is what preserves `inject` on the module surface.
