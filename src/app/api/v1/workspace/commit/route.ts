import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';
// A demo block naming a GitHub address is copied from GitHub when the commit is made.
export const maxDuration = 120;

export const POST = h.postWorkspaceCommit;
export const { GET, PUT, PATCH, DELETE } = methodNotAllowed('POST');
