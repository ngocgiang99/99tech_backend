export class InvalidJwtError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'InvalidJwtError';
    this.cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidJwtError);
    }
  }
}
