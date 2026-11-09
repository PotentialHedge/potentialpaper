import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getMyTokens;
export const { POST, PATCH, PUT, DELETE } = methodNotAllowed('GET');
