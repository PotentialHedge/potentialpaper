import * as s from '@/server/api/signals';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = s.getSet;
export const { POST, PUT, PATCH, DELETE } = methodNotAllowed('GET');
