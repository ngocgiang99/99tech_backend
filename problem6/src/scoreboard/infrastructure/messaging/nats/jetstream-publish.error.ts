export class JetStreamPublishError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'JetStreamPublishError';
    this.cause = cause;
  }
}
