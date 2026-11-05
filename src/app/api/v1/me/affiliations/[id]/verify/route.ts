import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const POST = h.verifyAffiliationRoute;
export const { GET, PUT, PATCH, DELETE } = methodNotAllowed('POST');
