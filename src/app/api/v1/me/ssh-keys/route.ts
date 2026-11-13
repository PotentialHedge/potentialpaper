import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getMySshKeys;
export const POST = h.postMySshKey;
export const { PATCH, PUT, DELETE } = methodNotAllowed('GET', 'POST');
