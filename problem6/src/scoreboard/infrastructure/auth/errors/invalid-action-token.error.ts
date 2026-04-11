export class InvalidActionTokenError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'InvalidActionTokenError';
    this.cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidActionTokenError);
    }
  }
}
