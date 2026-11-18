import * as s from '@/server/api/signals';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const PUT = s.putLabels;
export const { GET, POST, PATCH, DELETE } = methodNotAllowed('PUT');
