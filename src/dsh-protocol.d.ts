/**
 * Type augmentation for the workspace build of
 * `@deepseek-ai/dsh-typert-protocol`: the published 0.1.0-rc.6 declarations
 * predate `RemoteError`/`remoteErrorOf`, which the running host exports
 * (src/remote-error.ts in the app.asar checkout). This file supplies just
 * those two symbols; remove once a release ships them in lib/types.
 */

export {}

declare module '@deepseek-ai/dsh-typert-protocol' {
  export class RemoteError<Code extends string = string> extends Error {
    readonly isDSHRemoteError: true
    readonly code: Code
    readonly details: Record<string, unknown>
    constructor(
      code: Code,
      message: string,
      details: Record<string, unknown>,
      options?: { cause?: unknown },
    )
  }

  export function remoteErrorOf(error: unknown): RemoteError | undefined
}
