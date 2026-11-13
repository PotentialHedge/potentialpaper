import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const POST = h.postFile;
export const { GET, PATCH, PUT, DELETE } = methodNotAllowed('POST');
