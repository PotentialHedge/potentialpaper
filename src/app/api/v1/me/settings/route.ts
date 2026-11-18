import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getMySettings;
export const PUT = h.putMySettings;
export const PATCH = h.patchMySettings;
export const { POST, DELETE } = methodNotAllowed('GET', 'PUT', 'PATCH');
