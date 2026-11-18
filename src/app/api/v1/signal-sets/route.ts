import * as s from '@/server/api/signals';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = s.listSets;
export const POST = s.registerSet;
export const { PUT, PATCH, DELETE } = methodNotAllowed('GET', 'POST');
