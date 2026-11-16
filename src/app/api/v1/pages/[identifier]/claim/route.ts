import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getPageClaim;
export const POST = h.postPageClaim;
export const DELETE = h.deletePageClaim;
export const { PUT, PATCH } = methodNotAllowed('GET', 'POST', 'DELETE');
