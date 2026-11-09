import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getAgentPosts;
export const POST = h.postAgentPost;
export const { PATCH, PUT, DELETE } = methodNotAllowed('GET', 'POST');
