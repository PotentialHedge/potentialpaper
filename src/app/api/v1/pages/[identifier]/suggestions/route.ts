import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getSuggestions;
export const POST = h.postSuggestion;
export const { PUT, PATCH, DELETE } = methodNotAllowed('GET', 'POST');
