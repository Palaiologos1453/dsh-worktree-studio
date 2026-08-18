/** Typed failures returned by the task manager and Web adapter. */

export type StudioErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'state-conflict'
  | 'git-failure'
  | 'validation-failed'
  | 'merge-conflict'
  | 'unsafe-path'
  | 'recovery-required'
  | 'busy'

/** Domain error with a stable client-facing code and HTTP status hint. */
export class StudioError extends Error {
  readonly code: StudioErrorCode
  readonly status: number

  /**
   * @param code - Stable error category.
   * @param message - Human-readable correction or failure detail.
   * @param status - HTTP status used by the Web adapter.
   * @param options - Optional original cause.
   */
  constructor(code: StudioErrorCode, message: string, status = defaultStatus(code), options?: ErrorOptions) {
    super(message, options)
    this.name = 'StudioError'
    this.code = code
    this.status = status
  }
}

/** Map domain categories to HTTP responses without exposing implementation errors. */
function defaultStatus(code: StudioErrorCode): number {
  switch (code) {
    case 'invalid-input':
    case 'unsafe-path':
      return 400
    case 'not-found':
      return 404
    case 'state-conflict':
    case 'merge-conflict':
    case 'validation-failed':
    case 'busy':
    case 'recovery-required':
      return 409
    case 'git-failure':
      return 502
  }
}

/** Convert an arbitrary thrown value to a bounded diagnostic string. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return String(value)
  } catch {
    return '<unrenderable error>'
  }
}

