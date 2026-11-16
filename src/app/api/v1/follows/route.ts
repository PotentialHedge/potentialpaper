import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getFollow;
export const POST = h.postFollow;
export const DELETE = h.deleteFollow;
export const { PUT, PATCH } = methodNotAllowed('GET', 'POST', 'DELETE');
