import * as paperSignalsRoute from '@/app/api/v1/pages/[identifier]/signals/route';
import * as signalSetsRoute from '@/app/api/v1/signal-sets/route';
import * as signalSetRoute from '@/app/api/v1/signal-sets/[owner]/[name]/route';
import * as signalColumnsRoute from '@/app/api/v1/signal-sets/[owner]/[name]/columns/route';
import * as signalNearestRoute from '@/app/api/v1/signal-sets/[owner]/[name]/nearest/route';
import * as signalValuesRoute from '@/app/api/v1/signal-sets/[owner]/[name]/values/route';
import * as signalLabelsRoute from '@/app/api/v1/signal-sets/[owner]/[name]/labels/route';
import * as signalGenerationsRoute from '@/app/api/v1/signal-sets/[owner]/[name]/generations/route';
import * as signalPublishRoute from '@/app/api/v1/signal-sets/[owner]/[name]/generations/[generation]/publish/route';
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
import * as importPapers from '@/app/api/v1/imports/papers/route';
import * as importSubmissions from '@/app/api/v1/imports/submissions/route';
import * as importVenues from '@/app/api/v1/imports/venues/route';
import * as importVersions from '@/app/api/v1/imports/versions/route';
import * as importPdfs from '@/app/api/v1/imports/pdfs/route';
import * as importLinks from '@/app/api/v1/imports/links/route';
import * as commentsRoute from '@/app/api/v1/comments/route';
import * as commentRoute from '@/app/api/v1/comments/[id]/route';
import * as commentReplies from '@/app/api/v1/comments/[id]/replies/route';
import * as commentPreview from '@/app/api/v1/comments/preview/route';
import * as myMentions from '@/app/api/v1/me/mentions/route';
import * as myPapers from '@/app/api/v1/me/papers/route';
import * as myCoAuthors from '@/app/api/v1/me/papers/co-authors/route';
import * as follows from '@/app/api/v1/follows/route';
import * as views from '@/app/api/v1/views/route';
import * as viewTime from '@/app/api/v1/views/time/route';
import * as analytics from '@/app/api/v1/analytics/route';
import * as transitions from '@/app/api/v1/transitions/route';
import * as mySettings from '@/app/api/v1/me/settings/route';
import * as siteSettings from '@/app/api/v1/settings/route';
import * as installedPlugins from '@/app/api/v1/plugins/installed/route';
import * as myPlugins from '@/app/api/v1/me/plugins/route';
import * as pluginGrants from '@/app/api/v1/me/plugins/grants/route';
import * as pluginIdentity from '@/app/api/v1/me/plugins/identity/route';
import { forgetIdentityKey } from '@/server/plugins/identity';
import * as pluginStorage from '@/app/api/v1/me/plugins/storage/route';
import * as pluginUpdates from '@/app/api/v1/me/plugins/updates/route';
import * as discoverPlugins from '@/app/api/v1/plugins/discover/route';
import * as pageSummary from '@/app/api/v1/pages/[identifier]/route';
import * as pageFiles from '@/app/api/v1/pages/[identifier]/files/route';
import * as pageMembersRoute from '@/app/api/v1/pages/[identifier]/members/route';
import * as pageSubmissions from '@/app/api/v1/pages/[identifier]/submissions/route';
import * as pageClaim from '@/app/api/v1/pages/[identifier]/claim/route';
import * as venuePapersRoute from '@/app/api/v1/pages/[identifier]/venue-papers/route';
import * as orgOverviewRoute from '@/app/api/v1/pages/[identifier]/org/route';
import * as orgChildrenRoute from '@/app/api/v1/pages/[identifier]/children/route';
import * as pageScoresRoute from '@/app/api/v1/pages/[identifier]/scores/route';
import * as pageScoreFieldRoute from '@/app/api/v1/pages/[identifier]/scores/[venue]/[field]/route';
import * as pagePapersRoute from '@/app/api/v1/pages/[identifier]/papers/route';
import * as topicsRoute from '@/app/api/v1/topics/route';
import * as changesRoute from '@/app/api/v1/changes/route';
import * as eventsRoute from '@/app/api/v1/events/route';
import * as topicRoute from '@/app/api/v1/pages/[identifier]/topic/route';
import * as paperTopicsRoute from '@/app/api/v1/pages/[identifier]/topics/route';
import * as topicPapersRoute from '@/app/api/v1/pages/[identifier]/topic-papers/route';
import * as suggestionsRoute from '@/app/api/v1/pages/[identifier]/suggestions/route';
import * as renameRoute from '@/app/api/v1/pages/[identifier]/rename/route';
import * as mergeRoute from '@/app/api/v1/pages/[identifier]/merge/route';
import * as protectionRoute from '@/app/api/v1/pages/[identifier]/protection/route';
import { getDb, getPool } from '@/db';
import { clearDevOutbox, devOutbox } from '@/server/mail';

import { encodeVersionFile } from '@/lib/versions';
import type { SubmissionStatus } from '@/lib/submissions';

export const ORIGIN = 'http://test.local';

export async function resetDatabase(): Promise<void> {
  await getDb().execute(sql`
    truncate table page_daily_counts, page_institution_counts, page_month_visitors, signal_values, signal_labels, signals, signal_sets, page_views, page_transitions, page_transition_visits, identity_keys, topic_suggestions, page_protection, org_members_due, page_redirects, scope_stats, scope_state, page_claims, plugin_refs, plugin_snapshots, user_plugin_grants, user_plugin_storage, site_settings, user_settings, page_links, page_members, page_member_sources, page_scope_names, page_parents, page_ancestors, pages, paper_follows, search_docs, bot_grants, comment_mentions, comment_aliases, comments, lfs_objects, ssh_keys, evidence_files, agent_posts, agent_files, api_tokens, agent_codes, author_claims, demo_pins, demo_snapshots, submission_notes, submissions, venues, pdf_documents, consumer_cursors, page_events, page_current, page_revisions, page_refs, page_objects, commit_identities, paper_lookup_misses, paper_identifiers, papers, institution_domains, affiliations, accounts, rate_limit_buckets, announcements,
      session, account, verification, "user"
    restart identity cascade
  `);
  clearDevOutbox();
  forgetIdentityKey();
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
  [/^\/imports\/papers(\?.*)?$/, importPapers],
  [/^\/imports\/submissions$/, importSubmissions],
  [/^\/imports\/venues$/, importVenues],
  [/^\/imports\/versions$/, importVersions],
  [/^\/imports\/pdfs$/, importPdfs],
  [/^\/imports\/links$/, importLinks],
  [/^\/comments(\?.*)?$/, commentsRoute],
  [/^\/comments\/preview$/, commentPreview],
  [/^\/comments\/(?<id>[^/?]+)\/replies(\?.*)?$/, commentReplies],
  [/^\/comments\/(?<id>[^/?]+)$/, commentRoute],
  [/^\/me\/mentions(\?.*)?$/, myMentions],
  [/^\/me\/papers$/, myPapers],
  [/^\/me\/papers\/co-authors$/, myCoAuthors],
  [/^\/follows(\?.*)?$/, follows],
  [/^\/views$/, views],
  [/^\/views\/time$/, viewTime],
  [/^\/analytics(\?.*)?$/, analytics],
  [/^\/transitions$/, transitions],
  [/^\/me\/settings$/, mySettings],
  [/^\/plugins\/installed(\?.*)?$/, installedPlugins],
  [/^\/me\/plugins(\?.*)?$/, myPlugins],
  [/^\/me\/plugins\/grants(\?.*)?$/, pluginGrants],
  [/^\/me\/plugins\/identity$/, pluginIdentity],
  [/^\/me\/plugins\/storage(\?.*)?$/, pluginStorage],
  [/^\/me\/plugins\/updates(\?.*)?$/, pluginUpdates],
  [/^\/plugins\/discover(\?.*)?$/, discoverPlugins],
  [/^\/pages\/(?<identifier>[^/?]+)\/files$/, pageFiles],
  [/^\/pages\/(?<identifier>[^/?]+)\/members(\?.*)?$/, pageMembersRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/submissions$/, pageSubmissions],
  [/^\/pages\/(?<identifier>[^/?]+)\/claim$/, pageClaim],
  [/^\/pages\/(?<identifier>[^/?]+)\/org$/, orgOverviewRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/children$/, orgChildrenRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/venue-papers(\?.*)?$/, venuePapersRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/scores(\?.*)?$/, pageScoresRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/scores\/(?<venue>[^/?]+)\/(?<field>[^/?]+)(\?.*)?$/, pageScoreFieldRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/papers(\?.*)?$/, pagePapersRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/signals(\?.*)?$/, paperSignalsRoute],
  [/^\/signal-sets(\?.*)?$/, signalSetsRoute],
  [/^\/signal-sets\/(?<owner>[^/?]+)\/(?<name>[^/?]+)\/columns(\?.*)?$/, signalColumnsRoute],
  [/^\/signal-sets\/(?<owner>[^/?]+)\/(?<name>[^/?]+)\/nearest(\?.*)?$/, signalNearestRoute],
  [/^\/signal-sets\/(?<owner>[^/?]+)\/(?<name>[^/?]+)\/values(\?.*)?$/, signalValuesRoute],
  [/^\/signal-sets\/(?<owner>[^/?]+)\/(?<name>[^/?]+)\/labels(\?.*)?$/, signalLabelsRoute],
  [/^\/signal-sets\/(?<owner>[^/?]+)\/(?<name>[^/?]+)\/generations$/, signalGenerationsRoute],
  [/^\/signal-sets\/(?<owner>[^/?]+)\/(?<name>[^/?]+)\/generations\/(?<generation>\d+)\/publish$/, signalPublishRoute],
  [/^\/signal-sets\/(?<owner>[^/?]+)\/(?<name>[^/?]+)$/, signalSetRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/topic$/, topicRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/topics$/, paperTopicsRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/topic-papers(\?.*)?$/, topicPapersRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/suggestions(\?.*)?$/, suggestionsRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/rename$/, renameRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/merge$/, mergeRoute],
  [/^\/pages\/(?<identifier>[^/?]+)\/protection$/, protectionRoute],
  [/^\/pages\/(?<identifier>[^/?]+)$/, pageSummary],
  [/^\/topics(\?.*)?$/, topicsRoute],
  [/^\/changes(\?.*)?$/, changesRoute],
  [/^\/events(\?.*)?$/, eventsRoute],
  [/^\/settings$/, siteSettings],
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
  opts: {
    cookie?: string;
    token?: string;
    body?: unknown;
    text?: string;
    form?: FormData;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { origin: opts.origin ?? ORIGIN, ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(new URL(`/api/v1${path}`, ORIGIN), {
    method,
    headers,
    body: opts.form ?? opts.text ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
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

/**
 * The version an imported submission is of, with what the venue decided: since layout 5 the one place a decision is
 * kept, so a test that writes a bot's `submission.json` by hand writes this beside it, as the import does.
 */
export function submittedVersion(
  forum: string,
  venue: string,
  status: SubmissionStatus | null,
  decision: string | null = null,
): { path: string; content: string } {
  const url = `https://openreview.net/forum?id=${forum}`;
  return {
    path: `versions/v_${forum.toLowerCase()}.json`,
    content: encodeVersionFile({
      id: `v_${forum.toLowerCase()}`,
      label: venue,
      kind: 'submitted',
      url,
      submissions: [
        {
          venue,
          ...(status ? { status } : {}),
          ...(decision ? { decision } : {}),
          url,
          reviews: `openreview/${forum.toLowerCase()}`,
        },
      ],
    }),
  };
}
