import { getEvents } from '@/server/api/events';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = getEvents;
export const { POST, PUT, PATCH, DELETE } = methodNotAllowed('GET');
