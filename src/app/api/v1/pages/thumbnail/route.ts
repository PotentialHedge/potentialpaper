import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const POST = h.postThumbnail;
export const DELETE = h.deleteThumbnail;
export const { GET, PUT, PATCH } = methodNotAllowed('POST', 'DELETE');
