import * as h from '@/server/api/imports';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getImportPapers;
export const POST = h.postImportPapers;
export const { PUT, PATCH, DELETE } = methodNotAllowed('GET', 'POST');
