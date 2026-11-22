/**
 * The category forms' calls to `/api/v1` (`handoffs/pages.md` Phase 5): what went wrong, in words a reader can act on.
 * Browser only.
 */

export interface ApiFailure {
  message: string;
  code: string | null;
  details: Record<string, unknown> | null;
}

export async function failureOf(res: Response): Promise<ApiFailure> {
  if (res.status === 401) return { message: 'Sign in first.', code: 'unauthorized', details: null };
  const body = await res.json().catch(() => null);
  return {
    message: body?.error?.message ?? `Something went wrong (${res.status}).`,
    code: body?.error?.code ?? null,
    details: body?.error?.details ?? null,
  };
}

export async function send(method: string, path: string, body: unknown): Promise<Response> {
  return fetch(`/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A category a form offers as one types (`GET /api/v1/categories?q=`). */
export interface CategoryMatch {
  identifier: string;
  key: string;
  name: string;
  exact: boolean;
}

export async function findCategories(q: string, signal?: AbortSignal): Promise<CategoryMatch[]> {
  if (q.trim().length < 2) return [];
  const res = await fetch(`/api/v1/categories?q=${encodeURIComponent(q.trim())}`, { signal });
  if (!res.ok) return [];
  return ((await res.json()) as { categories: CategoryMatch[] }).categories;
}
