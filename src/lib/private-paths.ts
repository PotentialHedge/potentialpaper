/**
 * Pages that are personal, part of the auth flow, or endless like search results: disallowed in `app/robots.ts` and sent with
 * `X-Robots-Tag: noindex` (`next.config.ts`), since robots.txt stops a crawl but not an index entry. Add
 * a page here, never to one of the two alone. Imported by `next.config.ts`, so relative imports only.
 */
export const PRIVATE_PAGES = [
  '/profile',
  '/signin',
  '/signin/link',
  '/welcome',
  '/verify-email',
  '/set-password',
  '/institutions/request',
  '/admin/institutions',
  '/search',
];
