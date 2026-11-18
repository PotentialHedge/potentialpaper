import { z } from 'zod';
import { PAGE_KINDS } from '@/lib/kinds';
import { MAX_EVENTS, MAX_WAIT_S, waitForFeed } from '../events-feed';
import { parseQuery, route } from './http';

const EventsQuery = z.object({
  after: z.string().max(50).optional(),
  kind: z
    .string()
    .max(100)
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : []))
    .pipe(z.array(z.enum(PAGE_KINDS))),
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS).default(100),
  wait: z.coerce.number().int().min(0).max(MAX_WAIT_S).default(0),
});

/**
 * `GET /events?after=<cursor>&kind=paper&limit=100&wait=25`: commits to pages, oldest first, from a cursor
 * (`server/events-feed.ts`). Public, as every page's history is, and never cached: each answer depends on the moment.
 */
export const getEvents = route(async (req) => {
  const query = parseQuery(req, EventsQuery);
  const page = await waitForFeed({
    after: query.after,
    kinds: query.kind,
    limit: query.limit,
    waitMs: query.wait * 1000,
    signal: req.signal,
  });
  return Response.json(page, { headers: { 'Cache-Control': 'no-store' } });
});
