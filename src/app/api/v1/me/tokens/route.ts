import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getMyTokens;
export const POST = h.postMyToken;
export const { PATCH, PUT, DELETE } = methodNotAllowed('GET', 'POST');
