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
  'link_closed',
  'affiliation_taken',
  'primary_affiliation',
  'password_already_set',
  'invalid_handle',
  'invalid_link',
  'handle_taken',
  'institution_already_listed',
  'domain_not_institutional',
  'source_unavailable',
  'edit_conflict',
  'paper_merged',
  'page_busy',
  'generation_conflict',
  'claim_taken',
  'claim_decided',
  'page_exists',
  'method_not_allowed',
  'internal_error',
  // A push (`server/pages/receive.ts`).
  'fetch_first',
  'not_fast_forward',
  'wrong_identity',
  // SSH keys (`server/ssh-keys.ts`).
  'invalid_ssh_key',
  'ssh_key_taken',
  'too_many_ssh_keys',
  // Plugins (`server/plugins/`).
  'plugin_changed',
  'storage_full',
  // Pages above the paper (`handoffs/pages.md` Phase 5).
  'page_merged',
  'page_protected',
  'topic_exists',
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
