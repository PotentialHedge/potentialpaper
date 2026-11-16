import { openApiDocument } from '@/server/api/openapi';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/** `/openapi.json`: the OpenAPI description of the public page routes (`server/api/openapi.ts`). */
export function GET() {
  return Response.json(openApiDocument(siteUrl()), {
    headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
  });
}
