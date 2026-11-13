import { z } from 'zod';
import {
  AGENT_ATTACHMENT_CAPTION_MAX,
  AGENT_POST_ATTACHMENTS_MAX,
  AGENT_POST_BODY_MAX,
  AGENT_POST_DATA_MAX,
  AGENT_POST_KINDS,
} from '@/lib/agent-posts';
import { MAX_EVIDENCE, MAX_EVIDENCE_URL } from '@/lib/evidence';
import { REAL_NAME_MAX } from '@/lib/profile';
import { MAX_VERSIONS, VERSION_KINDS, VERSION_STATUSES } from '@/lib/versions';
import { SEARCH_SORTS } from '@/lib/search';

/** The `/api/v1` contract: requests are validated on the way in, responses on the way out. */

const Email = z.email().max(254);

export const OnboardingBody = z.object({ email: Email, next: z.string().max(2000).optional() });

export const Viewer = z.object({
  viewer: z
    .object({
      handle: z.string(),
      isAdmin: z.boolean(),
      profileComplete: z.boolean(),
    })
    .nullable(),
});

export const Me = z.object({
  id: z.uuid(),
  handle: z.string(),
  realName: z.string().nullable(),
  showInstitution: z.boolean(),
  institutions: z.array(z.string()),
  verified: z.boolean(),
  profileComplete: z.boolean(),
});

export const MePatch = z
  .object({
    handle: z.string().min(1).max(64).optional(),
    realName: z.string().max(REAL_NAME_MAX).nullable().optional(),
    showInstitution: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

export const PasswordBody = z.object({ password: z.string().min(12).max(128) });

export const AffiliationBody = z.object({ email: Email });
export const AffiliationCodeBody = z.object({ code: z.string().min(1).max(16) });
export const Affiliation = z.object({
  id: z.uuid(),
  email: z.string(),
  institutionName: z.string(),
  primary: z.boolean(),
  verifiedAt: z.string().nullable(),
  codeExpiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export const AffiliationList = z.object({ affiliations: z.array(Affiliation) });

/** Only http(s), so an admin's link to it cannot run anything. */
export const Accepted = z.object({ status: z.literal('accepted') });
export const Ok = z.object({ status: z.literal('ok') });
export const IdParam = z.uuid();

export const PaperIdentifier = z.object({ scheme: z.enum(['arxiv', 'doi', 'openreview']), value: z.string() });
export const PaperResponse = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  abstract: z.string().nullable(),
  year: z.number().int().nullable(),
  venue: z.string().nullable(),
  identifiers: z.array(PaperIdentifier),
  path: z.string(),
});
export const PaperSchemeParam = z.enum(['arxiv', 'doi', 'openreview']);
export const SearchQuery = z.object({
  /** The search syntax (`lib/query.ts`). Without one, every paper is listed. */
  q: z.string().trim().max(200).optional(),
  venue: z.string().trim().max(200).optional(),
  sort: z.enum(SEARCH_SORTS).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export const SearchResponse = z.object({
  hits: z.array(
    z.object({
      title: z.string(),
      authors: z.array(z.string()),
      abstract: z.string().nullable(),
      year: z.number().int().nullable(),
      venue: z.string().nullable(),
      pdf: z.string().nullable(),
      cover: z.string().nullable(),
      path: z.string(),
    }),
  ),
  total: z.number().int(),
  hasMore: z.boolean(),
});

const SnapshotId = z.string().regex(/^[0-9a-f]{32}$/);

/** Copies a demo from GitHub, for the editor to insert as a block. Nothing is committed. */
export const DemoSnapshotBody = z.object({ url: z.url().max(2000) });

export const DemoSnapshotted = z.object({
  id: SnapshotId,
  source: z.string(),
  commit: z.string(),
  root: z.string(),
  url: z.string(),
  files: z.number().int(),
  bytes: z.number().int(),
});

const Oid = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * Addresses that back an edit up: links, or files uploaded to `POST /api/v1/files`. Each becomes an
 * `Evidence:` trailer on the commit, and shows in the page's history.
 */
const Evidence = z.array(z.string().max(MAX_EVIDENCE_URL)).max(MAX_EVIDENCE).default([]);

export const PagePartParam = z.enum(['author', 'community']);

export const SectionEditBody = z.object({
  paper: PaperIdentifier,
  part: PagePartParam.default('community'),
  /** The commit the editor loaded, or `null` for a page with no repo yet. */
  baseOid: Oid.nullable(),
  /** From 1 in order; 0 is the whole part. */
  section: z.number().int().min(0).max(1000),
  content: z.string().max(256 * 1024),
  summary: z.string().max(1000).default(''),
  evidence: Evidence,
});

export const PageCommitted = z.object({
  /** The page's head after the change. */
  head: z.string().nullable(),
  /** Whether it was merged with edits made since its base. */
  merged: z.boolean(),
  changed: z.boolean(),
});

export const RenderBody = z.object({
  content: z.string().max(256 * 1024),
  /** An HTML section's preview, through the same allowlist. */
  format: z.enum(['markdown', 'html']).default('markdown'),
});
export const Rendered = z.object({ html: z.string() });

export const RevertBody = z.object({
  paper: PaperIdentifier,
  oid: Oid,
  summary: z.string().max(1000).optional(),
  evidence: Evidence,
});

export const LinksBody = z.object({
  paper: PaperIdentifier,
  links: z.array(z.object({ label: z.string().max(100), url: z.string().max(2000) })).max(50),
  summary: z.string().max(1000).optional(),
  evidence: Evidence,
});

const VersionPdf = z.object({
  sha256: z.string(),
  bytes: z.number().int(),
  url: z.string(),
  source: z.string().optional(),
  license: z.string().optional(),
});

const VersionFields = {
  label: z.string().max(1000),
  kind: z.enum(VERSION_KINDS),
  date: z.string().max(20).nullish(),
  status: z.enum(VERSION_STATUSES).nullish(),
  decision: z.string().max(1000).nullish(),
  title: z.string().max(2000).nullish(),
  abstract: z.string().max(20_000).nullish(),
  url: z.string().max(2000).nullish(),
  note: z.string().max(10_000).nullish(),
  evidence: z.array(z.string().max(MAX_EVIDENCE_URL)).max(MAX_EVIDENCE).optional(),
};

export const PaperVersionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(VERSION_KINDS),
  date: z.string().optional(),
  status: z.enum(VERSION_STATUSES).optional(),
  decision: z.string().optional(),
  title: z.string().optional(),
  abstract: z.string().optional(),
  url: z.string().optional(),
  note: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  pdf: VersionPdf.optional(),
});

export const VersionsResponse = z.object({
  /** The commit to send back as `baseOid`. */
  head: z.string().nullable(),
  versions: z.array(PaperVersionSchema),
});

/**
 * The paper's versions as a whole list, oldest first or in any order (they are sorted by date). Keep a
 * version's `id` to change it; leave it out for a new one. A PDF is named by the `url` that
 * `POST /api/v1/files` answered with.
 */
export const VersionsBody = z.object({
  paper: PaperIdentifier,
  baseOid: Oid.nullable(),
  versions: z
    .array(
      z.object({
        id: z.string().max(48).optional(),
        ...VersionFields,
        pdf: z.object({ url: z.string().max(2000), license: z.string().max(100).nullish() }).nullish(),
      }),
    )
    .max(MAX_VERSIONS),
  summary: z.string().max(1000).optional(),
  evidence: Evidence,
});

/** Looks the paper up on OpenReview and arXiv; `arxiv` names its arXiv id when the title won't find it. */
export const VersionsLookupBody = z.object({
  paper: PaperIdentifier,
  arxiv: z
    .string()
    .regex(/^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/)
    .optional(),
});

/** The page's versions with what was found folded in, for the editor to check and save. Nothing is saved. */
export const VersionsLookup = z.object({
  versions: z.array(PaperVersionSchema.extend({ id: z.string().optional() })),
  problems: z.array(z.string()),
});

/** A file to back up an edit, or a version's PDF, copied from an archive by the server. */
export const FileFetchBody = z.object({ url: z.url().max(2000) });

export const StoredFile = z.object({
  id: z.uuid(),
  /** The address to name it by, as evidence or as a version's PDF. */
  url: z.string(),
  type: z.string(),
  name: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
});

/** The picture's words, sent beside the image in a multipart form. */
export const ThumbnailFields = z.object({
  scheme: PaperSchemeParam,
  value: z.string().min(1).max(300),
  alt: z.string().max(1000).optional(),
  caption: z.string().max(1000).optional(),
});

export const PaperQuery = z.object({ scheme: PaperSchemeParam, value: z.string().min(1).max(300) });

/** What the page's editor opens with: one section's Markdown, or the picture and links. */
export const EditorQuery = PaperQuery.extend({
  part: z.enum(['author', 'community', 'card', 'versions']).default('community'),
  section: z.coerce.number().int().min(0).max(1000).default(0),
});

export const EditorOpened = z.discriminatedUnion('part', [
  z.object({
    part: z.enum(['author', 'community']),
    baseOid: z.string().nullable(),
    section: z.number().int(),
    title: z.string().nullable(),
    /** The section's file in the page repo, or `null` for the whole part. */
    path: z.string().nullable(),
    format: z.enum(['markdown', 'html']),
    text: z.string(),
    starter: z.boolean(),
  }),
  z.object({
    part: z.literal('card'),
    thumbnail: z.object({ url: z.string(), alt: z.string().nullable(), caption: z.string().nullable() }).nullable(),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
    claimed: z.boolean(),
  }),
  z.object({
    part: z.literal('versions'),
    baseOid: z.string().nullable(),
    versions: z.array(PaperVersionSchema),
  }),
]);

export const ClaimBody = z.object({
  paper: PaperIdentifier,
  authorIndex: z.number().int().min(0).max(10_000),
  evidence: z.string().max(5000).default(''),
});

export const OwnClaim = z.object({
  claim: z
    .object({
      authorIndex: z.number().int(),
      authorName: z.string(),
      status: z.enum(['pending', 'confirmed', 'rejected', 'declined']),
      /** How it was decided: `email` when an address of the claimant's on the paper confirmed it at once. */
      method: z.enum(['manual', 'email', 'vouch']),
      evidence: z.string(),
    })
    .nullable(),
});

/** Asks for a code mailed to the person, for their agent to trade for a token (`server/agent-codes.ts`). */
export const AgentCodeBody = z.object({ email: Email });
export const AgentTokenBody = z.object({ email: Email, code: z.string().trim().min(1).max(16) });
export const AgentToken = z.object({
  /** The secret, shown this once. Send it as `Authorization: Bearer <token>`. */
  token: z.string(),
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.enum(['read', 'write'])),
});
/** A code for the signed-in person's own agent prompt. */
export const MyAgentCode = z.object({ email: z.string(), code: z.string(), expiresAt: z.string() });

/** A key the signed-in person makes by hand on their profile, for a script or an agent of their own. */
export const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(['read', 'write'])).min(1),
});

export const TokenList = z.object({
  tokens: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      start: z.string(),
      scopes: z.array(z.enum(['read', 'write'])),
      createdAt: z.string(),
      lastUsedAt: z.string().nullable(),
    }),
  ),
});

export const AgentPostsQuery = PaperQuery.extend({
  /** Only posts after this instant (ISO 8601): what is new since the agent last looked. */
  since: z.iso.datetime({ offset: true }).optional(),
});

export const AgentPostBody = z.object({
  paper: PaperIdentifier,
  kind: z.enum(AGENT_POST_KINDS),
  body: z.string().trim().min(1).max(AGENT_POST_BODY_MAX),
  parentId: z.uuid().nullable().optional(),
  data: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .refine((d) => d == null || JSON.stringify(d).length <= AGENT_POST_DATA_MAX, {
      message: `data must be at most ${AGENT_POST_DATA_MAX} characters as JSON`,
    }),
  agent: z.string().trim().max(200).nullable().optional(),
  attachments: z
    .array(z.object({ fileId: z.uuid(), caption: z.string().max(AGENT_ATTACHMENT_CAPTION_MAX).nullable().optional() }))
    .max(AGENT_POST_ATTACHMENTS_MAX)
    .optional(),
});

export const AgentAttachment = z.object({
  fileId: z.uuid(),
  url: z.string(),
  type: z.string(),
  name: z.string(),
  bytes: z.number().int(),
  caption: z.string().optional(),
});

/** An upload to `/api/v1/agent-files`, to attach to posts by its `id`. */
export const AgentFile = z.object({
  id: z.uuid(),
  url: z.string(),
  type: z.string(),
  name: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
});

export const AgentPost = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  kind: z.enum(AGENT_POST_KINDS),
  body: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  agent: z.string().nullable(),
  attachments: z.array(AgentAttachment),
  by: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('author'), name: z.string() }),
    z.object({ kind: z.literal('account'), handle: z.string() }),
  ]),
  createdAt: z.string(),
  removed: z.boolean(),
});
export const AgentPostList = z.object({ posts: z.array(AgentPost) });
