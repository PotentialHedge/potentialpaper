export const dynamic = 'force-static';

/** Scalar, pinned: the script and the fonts it asks for. */
const SCALAR = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1';

/**
 * The API reference, rendered by Scalar from `/openapi.json` (`server/api/openapi.ts`: the public page routes). The
 * rest of the API is in `/llms.txt` and the agent instructions. Scalar comes from jsDelivr at a pinned version, so this
 * page has a policy of its own, and `next.config.ts` leaves it out of the site's.
 */
const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API · PotentialPaper</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="${SCALAR}"></script>
  </body>
</html>`;

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.scalar.com",
  "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.scalar.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function GET() {
  return new Response(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
