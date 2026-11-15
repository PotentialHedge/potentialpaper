/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { sql } from 'drizzle-orm';
import * as authRoute from '@/app/api/auth/[...all]/route';
import * as me from '@/app/api/v1/me/route';
import * as affiliations from '@/app/api/v1/me/affiliations/route';
import * as affiliation from '@/app/api/v1/me/affiliations/[id]/route';
import * as affiliationVerify from '@/app/api/v1/me/affiliations/[id]/verify/route';
import * as password from '@/app/api/v1/me/password/route';
import * as onboarding from '@/app/api/v1/onboarding/route';
import * as demos from '@/app/api/v1/demos/route';
import * as pageRender from '@/app/api/v1/pages/render/route';
import * as pageRevert from '@/app/api/v1/pages/revert/route';
import * as workspace from '@/app/api/v1/workspace/route';
import * as workspaceBlob from '@/app/api/v1/workspace/blob/route';
import * as workspaceCommit from '@/app/api/v1/workspace/commit/route';
import * as workspaceRebase from '@/app/api/v1/workspace/rebase/route';
import * as workspaceFiles from '@/app/api/v1/workspace/files/route';
import * as claims from '@/app/api/v1/claims/route';
import * as agentCode from '@/app/api/v1/agent/code/route';
import * as agentToken from '@/app/api/v1/agent/token/route';
import * as myAgentCode from '@/app/api/v1/me/agent-code/route';
import * as myTokens from '@/app/api/v1/me/tokens/route';
import * as myToken from '@/app/api/v1/me/tokens/[id]/route';
import * as mySshKeys from '@/app/api/v1/me/ssh-keys/route';
import * as mySshKey from '@/app/api/v1/me/ssh-keys/[id]/route';
import * as agentPosts from '@/app/api/v1/agent-posts/route';
import * as agentPost from '@/app/api/v1/agent-posts/[id]/route';
import * as agentFiles from '@/app/api/v1/agent-files/route';
import * as pageVersions from '@/app/api/v1/pages/versions/route';
import * as files from '@/app/api/v1/files/route';
import * as commentsRoute from '@/app/api/v1/comments/route';
import * as commentRoute from '@/app/api/v1/comments/[id]/route';
import * as commentReplies from '@/app/api/v1/comments/[id]/replies/route';
import * as commentPreview from '@/app/api/v1/comments/preview/route';
import * as myMentions from '@/app/api/v1/me/mentions/route';
import { getDb, getPool } from '@/db';
import { clearDevOutbox, devOutbox } from '@/server/mail';

export const ORIGIN = 'http://test.local';

export async function resetDatabase(): Promise<void> {
  await getDb().execute(sql`
    truncate table comment_mentions, comment_aliases, comments, lfs_objects, ssh_keys, evidence_files, agent_posts, agent_files, api_tokens, agent_codes, author_claims, demo_pins, demo_snapshots, submission_notes, submissions, venues, pdf_documents, page_events, page_current, page_revisions, page_refs, page_objects, commit_identities, paper_lookup_misses, paper_identifiers, papers, institution_domains, affiliations, accounts, rate_limit_buckets,
      session, account, verification, "user"
    restart identity cascade
  `);
  clearDevOutbox();
}

export async function closePool(): Promise<void> {
  await getPool()
    .end()
    .catch(() => {});
}

const ROUTES: [RegExp, any][] = [
  [/^\/onboarding$/, onboarding],
  [/^\/me$/, me],
  [/^\/demos(\?.*)?$/, demos],
  [/^\/pages\/render$/, pageRender],
  [/^\/pages\/revert$/, pageRevert],
  [/^\/workspace(\?.*)?$/, workspace],
  [/^\/workspace\/blob(\?.*)?$/, workspaceBlob],
  [/^\/workspace\/commit$/, workspaceCommit],
  [/^\/workspace\/rebase$/, workspaceRebase],
  [/^\/workspace\/files$/, workspaceFiles],
  [/^\/claims(\?.*)?$/, claims],
  [/^\/agent\/code$/, agentCode],
  [/^\/agent\/token$/, agentToken],
  [/^\/me\/agent-code$/, myAgentCode],
  [/^\/me\/tokens$/, myTokens],
  [/^\/me\/tokens\/(?<id>[^/]+)$/, myToken],
  [/^\/me\/ssh-keys$/, mySshKeys],
  [/^\/me\/ssh-keys\/(?<id>[^/]+)$/, mySshKey],
  [/^\/agent-posts(\?.*)?$/, agentPosts],
  [/^\/agent-posts\/(?<id>[^/?]+)$/, agentPost],
  [/^\/agent-files$/, agentFiles],
  [/^\/pages\/versions(\?.*)?$/, pageVersions],
  [/^\/files$/, files],
  [/^\/comments(\?.*)?$/, commentsRoute],
  [/^\/comments\/preview$/, commentPreview],
  [/^\/comments\/(?<id>[^/?]+)\/replies(\?.*)?$/, commentReplies],
  [/^\/comments\/(?<id>[^/?]+)$/, commentRoute],
  [/^\/me\/mentions(\?.*)?$/, myMentions],
  [/^\/me\/password$/, password],
  [/^\/me\/affiliations$/, affiliations],
  [/^\/me\/affiliations\/(?<id>[^/]+)$/, affiliation],
  [/^\/me\/affiliations\/(?<id>[^/]+)\/verify$/, affiliationVerify],
];

export interface ApiResult {
  status: number;
  body: any;
}

/**
 * Commits files through the web editor's API, as an editor would: the whole new text of each, or `null` to
 * delete it. The message's first line is the summary; `Evidence:` trailers go in its last paragraph.
 */
export function commitFiles(
  cookie: string,
  paper: { scheme: string; value: string },
  baseOid: string | null,
  files: Record<string, string | null>,
  message = 'Edit',
) {
  const changes = Object.entries(files).map(([path, content]) => ({ path, content }));
  return api('POST', '/workspace/commit', { cookie, body: { paper, baseOid, changes, message } });
}

/** A request through the real route handler, as Next would make it. */
export async function api(
  method: string,
  path: string,
  opts: { cookie?: string; token?: string; body?: unknown; form?: FormData; origin?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { origin: opts.origin ?? ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(new URL(`/api/v1${path}`, ORIGIN), {
    method,
    headers,
    body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  for (const [pattern, module] of ROUTES) {
    const match = pattern.exec(path);
    if (match) {
      const res: Response = await module[method](request, { params: Promise.resolve({ ...match.groups }) });
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('json')) return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
      return { status: res.status, body: await res.json().catch(() => null) };
    }
  }
  throw new Error(`no route for ${path}`);
}

export async function authCall(method: 'GET' | 'POST', path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(new URL(`/api/auth${path}`, ORIGIN), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return (method === 'GET' ? authRoute.GET : authRoute.POST)(request);
}

export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

export function lastMailTo(email: string) {
  return [...devOutbox()].reverse().find((m) => m.to === email);
}

/** The whole way in, through the real endpoints: an email, the code from the mail. Returns the session cookie. */
export async function signUp(email: string): Promise<string> {
  const started = await api('POST', '/onboarding', { body: { email } });
  if (started.status !== 202) throw new Error(`sign-up failed: ${started.status} ${JSON.stringify(started.body)}`);
  const mail = lastMailTo(email);
  const code = /\b(\d{6})\b/.exec(mail?.subject ?? '')?.[1];
  if (!code) throw new Error(`no code in mail: ${mail?.subject}`);
  const confirmed = await authCall('POST', '/email-otp/verify-email', { body: { email, otp: code } });
  const cookie = cookieFrom(confirmed);
  if (!cookie.includes('session_token')) throw new Error(`no session: ${confirmed.status} ${await confirmed.text()}`);
  return cookie;
}
