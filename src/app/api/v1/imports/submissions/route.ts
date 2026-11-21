import * as h from '@/server/api/imports';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const POST = h.postImportSubmissions;
export const { GET, PUT, PATCH, DELETE } = methodNotAllowed('POST');
