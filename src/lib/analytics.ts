import { HOME_LIST_PARAMS } from './private-paths';

/**
 * Page analytics: the host-wide Umami instance in ~/ops, website "potentialpaper". Constants, not env: the
 * layout is prerendered for the edge cache and the image build sees no `.env*`, so an env value would be
 * read once, at build, and come out empty. Neither is a secret: both ship in every page.
 */
export const UMAMI_SCRIPT = 'https://analytics.potentialhedge.com/script.js';
export const UMAMI_WEBSITE_ID = 'd992302e-f47b-4ff8-9024-f2f5faf6b0fa';
/** Only hits from this host count, so `npm run dev` and staging load the script and record nothing. */
export const UMAMI_DOMAIN = 'potentialpaper.com';

/**
 * What analytics may learn about a URL. Umami records the full URL and referrer of every hit, and some of
 * ours carry what is not ours to hand on: a sign-in link's token, a verification address, a `?next=`
 * return URL. So a same-site URL keeps its path, the home page's list parameters, `/welcome`'s step, and where a
 * link of ours was posted (`?ref=acceptodds`, `utm_*`), never a hash; another site's URL keeps only its origin and
 * path. An allowlist: a parameter added later stays out until someone decides it belongs.
 */
const KEPT_PARAMS: ReadonlySet<string> = new Set([
  ...HOME_LIST_PARAMS,
  'step',
  'ref',
  'utm_source',
  'utm_medium',
  'utm_campaign',
]);

/** `url` as analytics may record it; `origin` is this site's. Unparseable input becomes ''. */
export function analyticsUrl(url: string, origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return '';
  }
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  if (parsed.origin !== new URL(origin).origin) {
    parsed.search = '';
    return parsed.toString();
  }
  const kept = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    if (KEPT_PARAMS.has(key)) kept.append(key, value);
  }
  parsed.search = kept.toString();
  return parsed.toString();
}
