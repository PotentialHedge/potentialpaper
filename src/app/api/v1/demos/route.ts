import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';
// Copying a demo downloads its repo from GitHub.
export const maxDuration = 120;

export const POST = h.postDemo;
export const DELETE = h.deleteDemo;
export const { GET, PUT, PATCH } = methodNotAllowed('POST', 'DELETE');
