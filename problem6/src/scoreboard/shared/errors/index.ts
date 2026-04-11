export {
  DomainError,
  ValidationError,
  BadRequestError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  RateLimitError,
  DependencyUnavailableError,
  InternalError,
} from './domain-error';
export type { DomainErrorOptions } from './domain-error';

export {
  ERROR_CODES,
  ERROR_CODE_META,
  errorStatusFor,
  defaultMessageFor,
} from './error-codes';
export type { ErrorCode, ErrorCodeMetaEntry } from './error-codes';

export {
  MAX_CAUSE_DEPTH,
  MAX_QUERY_BYTES,
  buildErrorMetadata,
  buildBackgroundErrorMetadata,
  walkCause,
} from './error-metadata';
export type {
  BackgroundContext,
  CauseEntry,
  ErrorMetadata,
} from './error-metadata';

export { DEFAULT_HEADER_DENYLIST, scrubHeaders } from './scrub-headers';

export { attachPgCode, isPgError, mapDbError } from './map-db-error';
export type { PgLikeError } from './map-db-error';

export {
  MESSAGE_MAX_LEN,
  toPublicResponse,
  truncate,
} from './to-public-response';
export type { PublicErrorBody } from './to-public-response';

export { isRedisInfrastructureError, wrapUnknown } from './wrap-unknown';
