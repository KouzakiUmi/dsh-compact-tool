/**
 * Context augmentation for the client-only service keys this bundle consumes.
 * The owning client packages (@deepseek-ai/dsh-client-locale,
 * dsh-client-ui-slots) are not published to npm, so the faces this plugin
 * uses are declared here against the observed slot contracts.
 */

import type { ComponentType } from 'react'

declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: {
      register(ns: string, dicts: Record<string, Record<string, string>>): () => void
      bind(ns: string): (key: string, vars?: Record<string, unknown>) => string
      resolveText(text: unknown): string
    }
    slots: {
      inject(name: string, factory: () => (() => void) | void): () => void
      register(
        options: {
          name: string
          id: string
          order?: number | undefined
          label?: string | (() => string) | undefined
          locale?: string | undefined
          inject?: ((...args: never[]) => Record<string, unknown>) | undefined
        },
        component: ComponentType<never>,
      ): () => void
    }
  }
}

export {}
