import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';
// Copying a demo downloads its repo from GitHub.
export const maxDuration = 120;

export const POST = h.postDemoSnapshot;
export const { GET, PUT, PATCH, DELETE } = methodNotAllowed('POST');
