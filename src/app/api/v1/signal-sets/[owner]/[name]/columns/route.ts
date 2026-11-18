import * as s from '@/server/api/signals';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = s.getColumns;
export const { POST, PUT, PATCH, DELETE } = methodNotAllowed('GET');
