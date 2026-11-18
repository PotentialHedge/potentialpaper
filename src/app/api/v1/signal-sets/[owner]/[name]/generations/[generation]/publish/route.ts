import * as s from '@/server/api/signals';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const POST = s.postPublish;
export const { GET, PUT, PATCH, DELETE } = methodNotAllowed('POST');
