import { methodNotAllowed } from '@/server/api/http';
import { gitGet, gitPost, gitPut } from '@/server/git/http';

export const dynamic = 'force-dynamic';
// A clone of a long history is one response, streamed as it is read.
export const maxDuration = 120;

/** Clone and fetch, over git's smart and dumb HTTP protocols (DESIGN.md §4.6, `server/git/http.ts`). */
export function GET(req: Request): Promise<Response> {
  return gitGet(req);
}

export function POST(req: Request): Promise<Response> {
  return gitPost(req);
}

/** Git LFS uploads a PDF or picture this way (`server/git/lfs.ts`). */
export function PUT(req: Request): Promise<Response> {
  return gitPut(req);
}

export const { PATCH, DELETE } = methodNotAllowed('GET', 'POST', 'PUT');
