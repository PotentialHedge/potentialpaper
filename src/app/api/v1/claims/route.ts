import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getClaim;
export const POST = h.postClaim;
export const DELETE = h.deleteClaim;
export const { PUT, PATCH } = methodNotAllowed('GET', 'POST', 'DELETE');
