/**
 * The public API's error codes. Every error the API returns has the shape
 * `{ error: { code, message, details? } }` with `code` from this list.
 *
 * **Stable.** Clients branch on these strings, so renaming or removing one is a
 * breaking change to `/api/v1`. Adding one is not.
 */
export const API_ERROR_CODES = [
  'not_found',
  'validation_error',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'not_verified',
  'email_domain_not_allowed',
  'already_affiliated',
  'too_many_pending',
  'invalid_code',
  'affiliation_taken',
  'primary_affiliation',
  'password_already_set',
  'invalid_handle',
  'handle_taken',
  'institution_already_listed',
  'domain_not_institutional',
  'method_not_allowed',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}
