import { z } from 'zod';
import {
  AGENT_ATTACHMENT_CAPTION_MAX,
  AGENT_POST_ATTACHMENTS_MAX,
  AGENT_POST_BODY_MAX,
  AGENT_POST_DATA_MAX,
  AGENT_POST_KINDS,
} from '@/lib/agent-posts';
import { BOT_SOURCES } from '@/lib/bot-sources';
import { MAX_EVIDENCE, MAX_EVIDENCE_URL } from '@/lib/evidence';
import { CLAIM_STATUSES, TOKEN_SCOPES } from '@/db/schema';
import { BIO_MAX, REAL_NAME_MAX } from '@/lib/profile';
import { MAX_SUBMISSIONS, MAX_VERSIONS, VERSION_KINDS } from '@/lib/versions';
import { SUBMISSION_STATUSES } from '@/lib/submissions';
import { SEARCH_SORTS } from '@/lib/search';
import { MAX_COMMENT_LENGTH } from '@/lib/comments';

/** The `/api/v1` contract: requests are validated on the way in, responses on the way out. */

const Email = z.email().max(254);

export const OnboardingBody = z.object({ email: Email, next: z.string().max(2000).optional() });

export const Viewer = z.object({
  viewer: z
    .object({
      handle: z.string(),
      isAdmin: z.boolean(),
      profileComplete: z.boolean(),
      /** Holds a live API token, so an agent already works for them. */
      hasAgent: z.boolean(),
    })
    .nullable(),
});

export const Me = z.object({
  id: z.uuid(),
  handle: z.string(),
  realName: z.string().nullable(),
  bio: z.string().nullable(),
  homepage: z.string().nullable(),
  orcid: z.string().nullable(),
  scholar: z.string().nullable(),
  showInstitution: z.boolean(),
  institutions: z.array(z.string()),
  verified: z.boolean(),
  profileComplete: z.boolean(),
  mentionMail: z.boolean(),
  followMail: z.boolean(),
});

export const MePatch = z
  .object({
    handle: z.string().min(1).max(64).optional(),
    realName: z.string().max(REAL_NAME_MAX).nullable().optional(),
    /** A few lines about the person, Markdown with TeX, on their page; `null` or blank clears it. */
    bio: z.string().max(BIO_MAX).nullable().optional(),
    /** Links on their page: an https homepage, an ORCID iD (or its orcid.org address), a Google Scholar profile's address. */
    homepage: z.string().max(400).nullable().optional(),
    orcid: z.string().max(400).nullable().optional(),
    scholar: z.string().max(400).nullable().optional(),
    showInstitution: z.boolean().optional(),
    /** Whether a `@` mention in a comment is mailed. */
    mentionMail: z.boolean().optional(),
    /** Whether edits and comments on followed papers are mailed. */
    followMail: z.boolean().optional(),
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
/**
 * A page of any kind (`lib/kinds.ts`'s `PageRef`): a paper by an identifier, any other kind by its kind and key,
 * `{ "scheme": "venue", "value": "iclr/2027" }`.
 */
export const PageSchemeParam = z.enum(['arxiv', 'doi', 'openreview', 'venue', 'category', 'org', 'user']);
export const PageIdentifier = z.object({ scheme: PageSchemeParam, value: z.string().min(1).max(300) });
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
      /**
       * With `in:page` or `in:reviews`: the files that matched, best first. `snippet` marks matched words with
       * U+E000 and U+E001.
       */
      matches: z.array(
        z.object({ path: z.string(), kind: z.string(), label: z.string().nullable(), snippet: z.string() }),
      ),
      matchCount: z.number().int(),
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

export const PagePartParam = z.enum(['owners', 'community']);

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
  paper: PageIdentifier,
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

export const VersionPdf = z.object({
  sha256: z.string(),
  bytes: z.number().int(),
  url: z.string(),
  source: z.string().optional(),
  license: z.string().optional(),
});

const VersionSubmissionSchema = z.object({
  /** The venue as people say it, for a venue with no page here. Read back filled in from the page's name. */
  venue: z.string().max(1000).optional(),
  /** The venue's page by its key, `neurips/2026`, in place of `venue`. */
  page: z.string().max(200).optional(),
  status: z.enum(SUBMISSION_STATUSES).optional(),
  decision: z.string().max(1000).optional(),
  /** Where it is presented, for a venue held in several places at once: "Sydney". */
  site: z.string().max(1000).optional(),
  number: z.number().int().optional(),
  url: z.string().max(2000).optional(),
  /** Set by the bot that imported the venue's reviews; only it and admins change such an entry. */
  reviews: z.string().max(400).optional(),
  evidence: z.array(z.string().max(MAX_EVIDENCE_URL)).max(MAX_EVIDENCE).optional(),
});

export const VersionFields = {
  label: z.string().max(1000),
  kind: z.enum(VERSION_KINDS),
  date: z.string().max(20).nullish(),
  submissions: z.array(VersionSubmissionSchema).max(MAX_SUBMISSIONS).optional(),
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
  submissions: z.array(VersionSubmissionSchema).optional(),
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
export const PageQuery = PageIdentifier;

/** What the page's editor opens with: one section's Markdown, or the picture and links. */
export const EditorQuery = PaperQuery.extend({
  part: z.enum(['owners', 'community', 'card', 'versions']).default('community'),
  section: z.coerce.number().int().min(0).max(1000).default(0),
});

export const EditorOpened = z.discriminatedUnion('part', [
  z.object({
    part: z.enum(['owners', 'community']),
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
      status: z.enum(CLAIM_STATUSES),
      /** How it was decided: `email` when an address of the claimant's on the paper confirmed it at once. */
      method: z.enum(['manual', 'email', 'vouch']),
      evidence: z.string(),
    })
    .nullable(),
});

/**
 * `GET /claims`: the viewer's claim, and what they need to make one. `authors` as printed (pick an `authorIndex` from
 * it); `taken`, the indices someone is already confirmed as. `addressOnPaper`: one of the viewer's confirmed addresses
 * is printed on its first page, so a claim confirms at once; `authorIndexOnPaper`, whose it is, where that is clear.
 * No address is ever shown. `hidden`: under review, so nothing says who claimed it, and only an author with an
 * address on it may claim.
 */
export const ClaimContext = OwnClaim.extend({
  authors: z.array(z.string()),
  taken: z.array(z.number().int()),
  confirmedNames: z.array(z.string()),
  hidden: z.boolean(),
  addressOnPaper: z.boolean(),
  authorIndexOnPaper: z.number().int().nullable(),
});

/**
 * A confirmed author adds a co-author: an account by `handle` and which printed author (`authorIndex`) it is, or a
 * `claim` someone made and is waiting on (`GET /me/papers`'s `waiting`).
 */
export const CoAuthorBody = z.union([
  z.object({
    paper: PaperIdentifier,
    handle: z.string().trim().min(1).max(64),
    authorIndex: z.number().int().min(0).max(10_000),
  }),
  z.object({ paper: PaperIdentifier, claim: z.uuid() }),
]);
/** `invited`: they were asked by handle and accept on My papers; otherwise they asked, and are now confirmed. */
export const CoAuthorAdded = z.object({ authorIndex: z.number().int(), authorName: z.string(), invited: z.boolean() });
/** The invited account's answer to an invitation (`addCoAuthor`). */
export const InvitationAnswerBody = z.object({ paper: PaperIdentifier, accept: z.boolean() });
/** Accounts whose handle starts with `q`, to pick a co-author from. */
export const ReviewingVenues = z.object({
  venues: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const HandleSearchQuery = z.object({ q: z.string().trim().min(1).max(64) });
export const HandleMatches = z.object({
  accounts: z.array(z.object({ handle: z.string(), institution: z.string().nullable() })),
});

/** Claim as author `authorIndex` by a code sent to `email`, an address printed on the paper. */
export const ClaimCodeBody = z.object({
  paper: PaperIdentifier,
  authorIndex: z.number().int().min(0).max(10_000),
  email: z.string().trim().min(3).max(320),
});
export const ClaimCodeSent = OwnClaim.extend({ sent: z.boolean() });
export const ClaimCodeConfirmBody = z.object({
  paper: PaperIdentifier,
  email: z.string().trim().min(3).max(320),
  code: z.string().trim().min(1).max(20),
});
/** Claim as author `authorIndex`, and ask the paper's confirmed co-authors to confirm it. */
export const ClaimAskBody = ClaimBody;
export const ClaimAsked = OwnClaim.extend({ asked: z.array(z.string()) });
/** A confirmed author denies a claim waiting on their paper. */
export const CoAuthorDenyBody = z.object({ paper: PaperIdentifier, claim: z.uuid() });
export const ClaimSuggestionsQuery = z.object({ q: z.string().max(200).optional() });
export const ClaimSuggestions = z.object({
  papers: z.array(
    z.object({
      paper: PaperIdentifier,
      path: z.string(),
      title: z.string(),
      year: z.number().int().nullable(),
      venue: z.string().nullable(),
      authors: z.array(z.string()),
      byEmail: z.boolean(),
      likely: z.number().int().nullable(),
      taken: z.array(z.number().int()),
      /** Under anonymous review: every name but the viewer's own is blank. */
      underReview: z.boolean(),
      mine: z.object({ authorIndex: z.number().int(), status: z.string() }).nullable(),
    }),
  ),
});

/** Whether the viewer follows a paper (`null` when nobody is signed in), and how many do. */
export const FollowState = z.object({ following: z.boolean().nullable(), followers: z.number().int() });
export const FollowBody = z.object({ paper: PaperIdentifier });
/** A page's beacon: its id (a paper's is the paper's id), and the page this tab read just before, if any. */
export const ViewBody = z.object({ page: z.uuid(), from: z.string().max(100).optional() });
/**
 * A page's unique viewers: the number for a signed-in caller only, `null` for anyone else. `shown`: whether the page
 * has enough viewers for the count to be shown (`MIN_SHOWN_VIEWS`); a signed-out reader is asked to sign in for it.
 */
export const ViewState = z.object({ views: z.number().int().nullable(), shown: z.boolean() });
export const ViewTimeBody = z.object({ page: z.uuid(), seconds: z.number().min(0).max(86_400) });
export const AnalyticsQuery = z.object({ page: z.uuid() });
const RelatedPage = z.object({ name: z.string(), address: z.string(), count: z.number().int() });
/** A page's analytics, for its owners (`server/page-analytics.ts`). Totals only, never who. */
export const Analytics = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      views: z.number().int(),
      git: z.number().int(),
      bots: z.number().int(),
      botSources: z.record(z.enum(BOT_SOURCES), z.number().int()),
    }),
  ),
  totalViews: z.number().int(),
  time: z.array(z.number().int()),
  institutions: z.array(z.object({ name: z.string(), visitors: z.number().int() })),
  next: z.array(RelatedPage),
  previous: z.array(RelatedPage),
});
export const TransitionsQuery = z.object({ min: z.coerce.number().int().min(1).default(1) });
/** How many visitors read one page and then another, per ordered pair, most first. Totals only. */
export const Transitions = z.object({
  transitions: z.array(z.object({ from: z.string(), to: z.string(), count: z.number().int().min(1) })),
});

/** The signed-in account's papers (`server/my-papers.ts`, `server/follows.ts`). */
export const MyPapers = z.object({
  following: z.array(
    z.object({
      title: z.string(),
      year: z.number().int().nullable(),
      venue: z.string().nullable(),
      paper: PaperIdentifier,
      path: z.string(),
      followedAt: z.string(),
    }),
  ),
  authored: z.array(
    z.object({
      title: z.string(),
      year: z.number().int().nullable(),
      venue: z.string().nullable(),
      paper: PaperIdentifier,
      path: z.string(),
      authors: z.array(z.string()),
      mine: z.object({
        authorIndex: z.number().int(),
        authorName: z.string(),
        status: z.enum(CLAIM_STATUSES),
        method: z.enum(['manual', 'email', 'vouch']),
        canStepDown: z.boolean(),
        /** For an invitation (`status: 'invited'`), the handle of the co-author who sent it. */
        invitedBy: z.string().nullable(),
      }),
      confirmed: z.array(z.object({ authorIndex: z.number().int(), authorName: z.string() })),
      waiting: z.array(
        z.object({
          claim: z.uuid(),
          authorIndex: z.number().int(),
          authorName: z.string(),
          evidence: z.string(),
          realName: z.string().nullable(),
          institutions: z.array(z.string()),
          /** The claimant's confirmed addresses, which they agreed to show by asking. */
          addresses: z.array(z.string()),
          createdAt: z.string(),
        }),
      ),
    }),
  ),
});

/** Asks for a code mailed to the person, for their agent to trade for a token (`server/agent-codes.ts`). */
export const AgentCodeBody = z.object({ email: Email });
export const AgentTokenBody = z.object({ code: z.string().trim().min(1).max(32) });
export const AgentToken = z.object({
  /** The secret, shown this once. Send it as `Authorization: Bearer <token>`. */
  token: z.string(),
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.enum(TOKEN_SCOPES)),
});
/** A code for the signed-in person's own agent prompt. */
export const MyAgentCode = z.object({ code: z.string(), expiresAt: z.string() });

/** `POST /agent/link`: what the agent says it is, shown to the person on the page they approve it on. */
export const AgentLinkBody = z.object({ agent: z.string().max(120).optional() });
export const AgentLinkStarted = z.object({
  /** The page the person opens, signs in on and approves. */
  url: z.string(),
  /** Only the agent's: poll `POST /agent/link/token` with it. */
  secret: z.string(),
  expiresAt: z.string(),
});
export const AgentLinkPollBody = z.object({ secret: z.string().trim().min(1).max(100) });
export const AgentLinkPending = z.object({ status: z.literal('pending'), expiresAt: z.string() });
export const AgentLinkAnswerBody = z.object({ id: z.string().trim().min(1).max(20), approve: z.boolean() });

/** A key the signed-in person makes by hand on their profile, for a script or an agent of their own. */
export const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
});

/** An SSH key the signed-in person adds on their profile, for git over SSH. `title` defaults to the key's comment. */
export const CreateSshKeyBody = z.object({
  key: z
    .string()
    .min(1)
    .max(16 * 1024),
  title: z.string().trim().max(100).optional(),
});

export const SshKeyRow = z.object({
  id: z.uuid(),
  title: z.string(),
  keyType: z.string(),
  fingerprint: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export const SshKeyList = z.object({ keys: z.array(SshKeyRow) });

export const TokenList = z.object({
  tokens: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      start: z.string(),
      scopes: z.array(z.enum(TOKEN_SCOPES)),
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

/**
 * The web editor's view of a page repo (`server/workspace.ts`, `docs/web-editor.md`): editor-neutral, so any
 * editor the site embeds speaks only this.
 */
export const WorkspaceResponse = z.object({
  paper: z.object({ scheme: PageSchemeParam, value: z.string(), title: z.string(), path: z.string() }),
  head: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      oid: z.string(),
      text: z.string().optional(),
      lfs: z.object({ sha256: z.string(), bytes: z.number().int(), url: z.string().nullable() }).optional(),
      readonly: z.string().nullable(),
    }),
  ),
  signedIn: z.boolean(),
  areas: z.record(z.string(), z.string().nullable()),
  /** Where to clone and push from. */
  clone: z.object({ https: z.string(), ssh: z.string().nullable() }),
});

export const WorkspaceBlobQuery = PageQuery.extend({ oid: Oid });

/** A folder or file of a page's repo, for its Repo tab (`server/pages/browse.ts`). */
export const RepoQuery = PageQuery.extend({ path: z.string().max(1000).default('') });

const RepoLast = z.object({ oid: z.string(), summary: z.string(), at: z.string() });

export const RepoFolderResponse = z.object({
  placeholder: z.boolean(),
  head: z
    .object({
      oid: z.string(),
      seq: z.number().int(),
      summary: z.string(),
      authorId: z.string(),
      handle: z.string().nullable(),
      authorName: z.string().nullable(),
      at: z.string(),
    })
    .nullable(),
  commits: z.number().int(),
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(['folder', 'file']),
      bytes: z.number().int().nullable(),
      lfs: z.boolean(),
      last: RepoLast.nullable(),
    }),
  ),
  readme: z.object({ path: z.string(), html: z.string() }).nullable(),
});

export const RepoFileResponse = z.object({
  placeholder: z.boolean(),
  path: z.string(),
  oid: z.string(),
  bytes: z.number().int(),
  view: z.discriminatedUnion('type', [
    z.object({ type: z.literal('markdown'), html: z.string() }),
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('lfs'),
      kind: z.enum(['pdf', 'image']),
      sha256: z.string(),
      bytes: z.number().int(),
      url: z.string().nullable(),
    }),
    z.object({ type: z.literal('binary') }),
    z.object({ type: z.literal('large') }),
  ]),
});

export const WorkspaceCommitBody = z.object({
  paper: PageIdentifier,
  baseOid: Oid.nullable(),
  changes: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        content: z
          .string()
          .max(1024 * 1024)
          .nullable(),
      }),
    )
    .min(1)
    .max(400),
  message: z.string().max(10_000),
});

export const WorkspaceCommitted = z.object({
  head: z.string().nullable(),
  merged: z.boolean(),
  changed: z.boolean(),
});

export const WorkspaceStored = z.object({ pointer: z.string(), sha256: z.string(), bytes: z.number().int() });

export const WorkspaceRebaseBody = WorkspaceCommitBody.omit({ message: true });

export const WorkspaceRebased = z.object({
  head: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      original: z.string().nullable(),
      content: z.string().nullable(),
      conflict: z.boolean(),
    }),
  ),
});

/** The discussion under a paper (`server/comments`). */
export const CommentsQuery = PaperQuery.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const CommentRepliesQuery = z.object({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const CommentBody = z.object({
  paper: PaperIdentifier,
  body: z.string().trim().min(1).max(MAX_COMMENT_LENGTH),
  parentId: z.uuid().nullable().optional(),
  /** Under the account's alias on this paper rather than its handle. Refused for one of its confirmed authors. */
  anonymous: z.boolean().optional(),
});

export const CommentPreviewBody = z.object({
  paper: PaperIdentifier,
  body: z.string().max(MAX_COMMENT_LENGTH),
});

export const CommentPreview = z.object({ html: z.string(), mentions: z.array(z.string()) });

const CommentAuthor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('author'), name: z.string(), isYou: z.boolean() }),
  z.object({ kind: z.literal('alias'), alias: z.string(), isYou: z.boolean() }),
  z.object({
    kind: z.literal('account'),
    handle: z.string(),
    realName: z.string().nullable(),
    bot: z.boolean(),
    isYou: z.boolean(),
  }),
]);

export const Comment = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  body: z.string().nullable(),
  html: z.string().nullable(),
  createdAt: z.string(),
  removed: z.boolean(),
  replyCount: z.number().int(),
  mentions: z.array(z.string()),
  /** The page's commit the comment was written against (the head when it was posted); null before the first. */
  pageCommit: z.string().nullable(),
  /** Commits to the page since `pageCommit`: 0 while the comment is about the page as it stands. */
  editsSince: z.number().int(),
  author: CommentAuthor,
});

export const CommentViewer = z.object({
  canComment: z.boolean(),
  handle: z.string(),
  alias: z.string().nullable(),
  authorName: z.string().nullable(),
});

export const CommentList = z.object({
  comments: z.array(Comment),
  /** Previews of the replies under `comments`, flat, oldest first: `parentId` makes the tree. */
  replies: z.array(Comment),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
  /** `null` for a visitor. */
  viewer: CommentViewer.nullable(),
});

export const CommentReplies = z.object({ replies: z.array(Comment) });

export const MentionsQuery = z.object({
  cursor: z.string().max(200).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const MentionList = z.object({
  mentions: z.array(z.object({ comment: Comment, paper: z.object({ title: z.string(), path: z.string() }) })),
  nextCursor: z.string().nullable(),
});

/** One problem in a settings.json (`lib/settings/document.ts`). */
export const SettingsProblem = z.object({
  severity: z.enum(['error', 'warning']),
  key: z.string().nullable(),
  line: z.number().int().positive(),
  message: z.string(),
});

/** A plugin's declared settings (`lib/settings/spec.ts`), which the values were resolved with. */
export const PluginSettingsList = z.array(
  z.object({ id: z.string(), title: z.string().optional(), settings: z.record(z.string(), z.unknown()) }),
);

/** `GET`/`PUT /me/settings`: the account's settings.json as written, and every setting's value. */
export const MySettings = z.object({
  plugins: PluginSettingsList,
  text: z.string(),
  values: z.record(z.string(), z.unknown()),
  problems: z.array(SettingsProblem),
  updatedAt: z.iso.datetime().nullable(),
});

/** `GET /settings`: the site layer and the values a reader who isn't signed in starts from. */
export const SiteSettings = z.object({
  text: z.string(),
  values: z.record(z.string(), z.unknown()),
  plugins: PluginSettingsList,
});

// Plugins (`handoffs/plugins.md` Phase 2, `server/plugins/`).

const PluginMissing = z.object({ permissions: z.array(z.string()), network: z.array(z.string()) });

/** A plugin as a page runs it (`lib/plugins/installed.ts`). */
export const InstalledPlugin = z.object({
  source: z.string(),
  ref: z.string().nullable(),
  enabled: z.boolean(),
  from: z.enum(['site', 'user', 'dev']),
  status: z.enum(['ready', 'consent', 'blocked', 'disabled', 'error']),
  error: z.string().optional(),
  plugin: z
    .object({
      id: z.string(),
      commit: z.string().nullable(),
      sourceUrl: z.string(),
      baseUrl: z.string(),
      origin: z.string(),
      manifest: z.record(z.string(), z.unknown()),
      bot: z
        .object({
          handle: z.string(),
          known: z.boolean(),
          grants: z.array(z.object({ kind: z.string(), pattern: z.string() })),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  missing: PluginMissing,
});

/** `GET /plugins/installed`: the reader's plugins, and what the page's \`when\` conditions need about the reader. */
export const InstalledPlugins = z.object({
  plugins: z.array(InstalledPlugin),
  viewer: z.object({ signedIn: z.boolean(), isOwner: z.boolean() }),
});

export const InstalledQuery = z.object({ page: z.string().max(400).optional() });

export const PluginInstallBody = z.object({ source: z.string().min(1).max(400) });
export const PluginSourceQuery = z.object({ source: z.string().min(1).max(400) });
export const PluginGrantBody = z.object({
  plugin: z.string().min(1).max(120),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
});
export const PluginIdQuery = z.object({ plugin: z.string().min(1).max(120) });
/** `POST /me/plugins/identity`: a token for one of the reader's plugins; `dev` for one loaded from localhost. */
export const PluginIdentityBody = z.object({ plugin: z.string().min(1).max(120), dev: z.boolean().optional() });
export const PluginIdentityToken = z.object({
  token: z.string(),
  expiresAt: z.string(),
  audience: z.string(),
  issuer: z.string(),
  subject: z.string(),
  handle: z.string(),
  jwksUrl: z.string(),
});
/** `/.well-known/jwks.json`: the keys that sign plugins' identity tokens. */
export const Jwks = z.object({
  keys: z.array(
    z.looseObject({
      kty: z.string(),
      crv: z.string(),
      x: z.string(),
      y: z.string(),
      kid: z.string(),
      alg: z.string(),
      use: z.string(),
    }),
  ),
});
export const PluginStorageBody = z.object({
  plugin: z.string().min(1).max(120),
  key: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
  /** `null` removes the key. */
  value: z.unknown(),
});
export const PluginStorage = z.object({ data: z.record(z.string(), z.unknown()), bytes: z.number().int() });

// Discovery and updates (`handoffs/plugins.md` Phase 3).

/** `GET /plugins/discover`: public repos with the topic `potentialpaper-plugin`, most starred first. */
export const DiscoveredPlugins = z.object({
  plugins: z.array(
    z.object({
      source: z.string(),
      owner: z.string(),
      repo: z.string(),
      description: z.string().nullable(),
      stars: z.number().int(),
      pushedAt: z.string().nullable(),
      htmlUrl: z.string(),
      avatarUrl: z.string().nullable(),
      topics: z.array(z.string()),
    }),
  ),
  fetchedAt: z.string(),
  stale: z.boolean(),
});

/** `GET /me/plugins/updates?plugin=<id>`: only that plugin, checked afresh. */
export const PluginUpdatesQuery = z.object({ plugin: z.string().min(1).max(200).optional() });

/** `GET /me/plugins/updates`: installed plugins with a newer release than the version they run. */
export const PluginUpdates = z.object({
  updates: z.array(
    z.object({
      source: z.string(),
      pluginId: z.string(),
      current: z.object({ ref: z.string().nullable(), commit: z.string().nullable(), version: z.string() }),
      latest: z.object({ tag: z.string(), commit: z.string(), version: z.string() }),
    }),
  ),
});

/** `POST /me/plugins/updates`: move a plugin to `ref` (by default its newest release). */
export const PluginUpdateBody = z.object({
  source: z.string().min(1).max(400),
  ref: z
    .string()
    .regex(/^[A-Za-z0-9_.\/-]{1,200}$/)
    .optional(),
  /** Approve what the new version asks for that the reader hasn't granted. Only from a browser session. */
  approve: z.boolean().optional(),
});

export const PluginUpdateResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('updated'), plugin: InstalledPlugin }),
  z.object({
    status: z.literal('consent'),
    to: z.object({ ref: z.string(), commit: z.string(), version: z.string(), name: z.string() }),
    missing: PluginMissing,
  }),
]);

/** A page of any kind, as plugins and links see it (`page.resolve`, `GET /pages/{identifier}`). */
export const PageSummary = z.object({
  kind: z.string(),
  identifier: z.string(),
  address: z.string(),
  url: z.string(),
  name: z.string(),
});

export const PageResponse = PageSummary.extend({
  /** The pages above it: a paper's venues, categories and orgs; an org's parents. */
  scopes: z.array(PageSummary),
  /** What `when` conditions test. */
  facts: z.object({
    hasScores: z.boolean(),
    hasSubmissions: z.boolean(),
    hasSignals: z.boolean(),
    /** A paper with a time it is presented at a venue: a poster session, an oral. */
    hasPresentations: z.boolean(),
  }),
});

/** `GET /pages/{identifier}/files`: what `page.read` gives, only what the page shows the public. */
export const PageFiles = z.object({
  page: PageSummary,
  /** Its kind file as it parses (`venue.json`, …); a paper's metadata. */
  kindFile: z.record(z.string(), z.unknown()).nullable(),
  sections: z.array(z.object({ part: z.string(), path: z.string(), title: z.string(), markdown: z.string() })),
  links: z.array(z.record(z.string(), z.unknown())),
  /** The commit the files are at; `null` for a page with no repo yet. */
  commit: z.string().nullable(),
});

export const PageMembersQuery = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  rollUp: z.enum(['true', 'false']).default('true'),
});

/** `GET /pages/{identifier}/members`: a scope's papers, rolled up from the pages under it. */
export const PageMembers = z.object({
  total: z.number().int(),
  papers: z.array(PageSummary.extend({ year: z.number().int().nullable(), via: z.array(z.string()) })),
  nextOffset: z.number().int().nullable(),
});

/** `GET /pages/{identifier}/submissions`: a paper's submissions with their notes and their venues' forms. */
export const PageSubmissions = z.object({ submissions: z.array(z.record(z.string(), z.unknown())) });

/** `POST /pages/{identifier}/claim`: asking to be confirmed as one of a venue's organisers. */
export const PageClaimBody = z.object({ evidence: z.string().max(5000) });

/** `GET`/`POST`/`DELETE /pages/{identifier}/claim`: the viewer's claim to organise a venue, if any. */
export const OwnPageClaim = z.object({
  claim: z
    .object({
      status: z.enum(['pending', 'confirmed', 'rejected']),
      evidence: z.string(),
      /** Confirmed through a claim on the venue above it: a series' organiser on an edition. */
      inherited: z.boolean(),
    })
    .nullable(),
});

/** `POST /pages/{identifier}/children`: a department or lab under an org, made by one of its verified members. */
export const OrgChildBody = z.object({
  /** The last segment of its key: `inf` makes `org:eth/inf`. */
  slug: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  /** Its own email domains, its organisation's or under them; none to take its papers only from labs under it. */
  domains: z.array(z.string().min(1).max(200)).max(20).optional(),
});

/** `GET /pages/{identifier}/org`: what an org page lists besides its papers. */
export const OrgOverview = z.object({
  parent: z.object({ identifier: z.string(), name: z.string(), url: z.string() }).nullable(),
  children: z.array(z.object({ identifier: z.string(), name: z.string(), url: z.string(), papers: z.number().int() })),
  /** Members who show their institution, by handle (DESIGN.md §5.3: only theirs). */
  people: z.array(z.object({ handle: z.string(), url: z.string() })),
  peopleCount: z.number().int(),
  venues: z.array(z.object({ identifier: z.string(), name: z.string(), url: z.string(), papers: z.number().int() })),
});

export const VenuePapersQuery = z.object({
  status: z.enum(['accepted', 'under_review', 'rejected', 'desk_rejected', 'withdrawn', 'unknown']).optional(),
  decision: z.string().min(1).max(200).optional(),
  q: z.string().max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** `GET /pages/{identifier}/venue-papers`: a venue's submissions, rolled up from its editions, by status. */
export const VenuePapers = z.object({
  total: z.number().int(),
  papers: z.array(
    z.object({
      title: z.string(),
      /** The paper's identifier and address here; `null` for a paper with no identifier. */
      identifier: z.string().nullable(),
      address: z.string().nullable(),
      status: z.string(),
      decision: z.string().nullable(),
      number: z.number().int().nullable(),
      /** The submission at its source: OpenReview's forum. */
      url: z.string().nullable(),
      /** The edition it was submitted to, on a series' page. */
      venue: z.object({ identifier: z.string(), address: z.string(), name: z.string() }).nullable(),
    }),
  ),
  nextOffset: z.number().int().nullable(),
});

const ScoreBins = z.object({
  lo: z.number(),
  hi: z.number(),
  width: z.number(),
  /** Means per bin, `[lo + i·width, lo + (i+1)·width)`, the last closed at `hi`. */
  counts: z.array(z.number().int()),
});

const ScoreGroup = z.object({ count: z.number().int(), values: z.array(z.number()), bins: ScoreBins });

const ScoreSummary = z.object({
  /**
   * `<source>:<venue id>`, as submissions name it: `openreview:ICLR.cc/2027/Conference`. `page` is the venue's own
   * page (the edition that lists it among its `sources`), whose statistics of it are the whole venue's; `null` for a
   * venue with no page (a track, TMLR).
   */
  venue: z.object({ id: z.string(), name: z.string(), page: PageSummary.nullable() }),
  /** The field's key in the venue's review forms: `rating`. */
  field: z.string(),
  label: z.string(),
  /** Submissions with a mean for this field. */
  count: z.number().int(),
  /** The range the venue's form states, when it does. */
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** How many of each outcome: accepted, rejected (desk rejections too), withdrawn, pending. */
  byStatus: z.record(z.string(), z.number().int()),
  /** Whether the venue has decided on any submission yet. */
  decisionsOut: z.boolean(),
  /** Withheld until the venue's decisions are out (the site's `plugins.venueStats.hideUntil`): no values or bins. */
  hidden: z.boolean(),
  computedAt: z.string(),
});

/** `GET /pages/{identifier}/scores`: a scope's venues and score fields, with counts. */
export const PageScores = z.object({
  page: PageSummary,
  /** The site's `plugins.venueStats.hideUntil`: `never` or `decisions`. */
  hideUntil: z.enum(['never', 'decisions']),
  scores: z.array(ScoreSummary),
});

/** `GET /pages/{identifier}/scores/{venue}/{field}`: one field's means, sorted, with bins and the split by outcome. */
export const PageScoreField = ScoreSummary.extend({
  page: PageSummary,
  /** Each submission's mean over its reviews, ascending. */
  values: z.array(z.number()),
  bins: ScoreBins,
  /** The same by outcome: `accepted`, `rejected`, `withdrawn`, `pending`. */
  split: z.record(z.string(), ScoreGroup),
  /**
   * With `?marks=true`: the scope's own submissions in this field, each with its paper and mean, ascending, to mark
   * on the venue's distribution. `null` when the scope has more than 1,000 here; empty when the numbers are withheld.
   */
  marks: z
    .array(
      z.object({
        identifier: z.string().nullable(),
        address: z.string().nullable(),
        title: z.string(),
        mean: z.number(),
        outcome: z.enum(['accepted', 'rejected', 'withdrawn', 'pending']),
      }),
    )
    .nullable()
    .optional(),
});

/** `GET /pages/{identifier}/scores/{venue}/{field}`: whether to name the scope's own submissions. */
export const PageScoreFieldQuery = z.object({ marks: z.enum(['true', 'false']).default('false') });

/** `GET /pages/{identifier}/papers`: which fields, and a chunk of them. */
export const PagePapersQuery = z.object({
  /** Comma-separated: `submissions`, `scores`, `status`. All three when left out; empty for the papers alone. */
  fields: z
    .string()
    .max(100)
    .optional()
    .transform((text, ctx) => {
      if (text === undefined) return ['submissions', 'scores', 'status'] as const;
      const fields = text
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
      const bad = fields.filter((f) => !['submissions', 'scores', 'status'].includes(f));
      if (bad.length > 0) {
        ctx.addIssue({ code: 'custom', message: `unknown field ${bad.join(', ')}: submissions, scores or status` });
      }
      return fields as ('submissions' | 'scores' | 'status')[];
    }),
  /** The cursor a previous chunk gave (`X-Next-Cursor`). */
  after: z.uuid().optional(),
  /** Papers in this chunk; left out, every paper in one stream. */
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

// Category pages (`handoffs/pages.md` Phase 5, `server/category-pages.ts`): Wikipedia-style categories with an article.

const categoryName = z.string().min(1).max(120);
const categorySlugParam = z.string().min(1).max(60);

/** `GET /categories?q=`: categories whose name is like `q`, the same name first. */
export const CategorySearchQuery = z.object({ q: z.string().max(120).default('') });

export const CategoryMatches = z.object({
  categories: z.array(
    z.object({
      identifier: z.string(),
      key: z.string(),
      name: z.string(),
      url: z.string(),
      /** The same name: making another category of it would be a duplicate. */
      exact: z.boolean(),
    }),
  ),
});

/** `POST /categories`: a new category. */
export const NewCategoryBody = z.object({
  name: categoryName,
  /** Its address; made from the name when absent. */
  slug: categorySlugParam.optional(),
  /** The article's first section, "What it is", in Markdown. */
  summary: z.string().max(20_000).optional(),
});

/** `POST /pages/{identifier}/categories`: puts a page in a category, by identifier, or by name (made if no category has it). */
export const PageCategoryBody = z
  .object({
    category: z.string().min(1).max(200).optional(),
    name: categoryName.optional(),
    note: z.string().max(2000).optional(),
  })
  .refine((body) => body.category || body.name, { message: 'give category (an identifier) or name' });

export const PageCategoryResult = z.object({
  category: PageSummary,
  created: z.boolean(),
  status: z.enum(['linked', 'exists']),
});

const CategoryMember = z.object({
  identifier: z.string().nullable(),
  url: z.string().nullable(),
  kind: z.string(),
  name: z.string().nullable(),
});

/** `GET /pages/{identifier}/category`: a category's subcategories and other pages, by name, as a Wikipedia category lists them. */
export const CategoryOverview = z.object({
  subcategories: z.array(CategoryMember),
  pages: z.array(CategoryMember),
  /** Categories merged into it, by their old identifiers. */
  mergedFrom: z.array(z.string()),
  protection: z
    .object({ level: z.string(), reason: z.string().nullable(), expiresAt: z.string().nullable() })
    .nullable(),
});

/** `PATCH /pages/{identifier}/category`: edits a category in one commit; what is left out stays. */
export const CategoryEditBody = z.object({
  /** The commit the form loaded. */
  base: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  name: categoryName.optional(),
  /** The whole article as Markdown, a `#` heading per section. */
  article: z.string().max(200_000).optional(),
  summary: z.string().max(500).optional(),
});

export const CategoryEdited = z.object({ head: z.string().nullable(), changed: z.boolean() });

/** `POST /pages/{identifier}/rename`: a category's new address, and optionally its new name. */
export const RenameBody = z.object({ slug: categorySlugParam, name: categoryName.optional() });

/** `POST /pages/{identifier}/merge`: merges this category into another. */
export const MergeBody = z.object({ into: z.string().min(1).max(200), summary: z.string().max(500).optional() });

/** `GET`/`PUT /pages/{identifier}/protection`. */
export const Protection = z.object({
  protection: z
    .object({
      level: z.enum(['established', 'admins']),
      reason: z.string().nullable(),
      expiresAt: z.string().nullable(),
    })
    .nullable(),
});

export const ProtectionBody = z.object({
  /** `null` lifts it. */
  level: z.enum(['established', 'admins']).nullable(),
  reason: z.string().max(500).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

/** `GET /changes`: the patrol feed. */
export const ChangesQuery = z.object({
  kind: z.enum(['paper', 'venue', 'category', 'org', 'user']).optional(),
  bots: z.enum(['true', 'false']).default('false'),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const Changes = z.object({
  changes: z.array(
    z.object({
      id: z.number().int(),
      page: z.object({ kind: z.string(), identifier: z.string(), url: z.string(), name: z.string() }),
      seq: z.number().int(),
      oid: z.string(),
      summary: z.string(),
      kind: z.string(),
      paths: z.array(z.string()),
      bytesDelta: z.number().int(),
      at: z.string(),
      /** A handle, a confirmed author's name on their own paper, or the system. */
      by: z.union([
        z.object({ handle: z.string() }),
        z.object({ authorName: z.string() }),
        z.object({ system: z.literal(true) }),
      ]),
      bot: z.boolean(),
      links: z.boolean(),
    }),
  ),
  /** `before` for the next page, or `null`. */
  next: z.number().int().nullable(),
});

/** `GET /events` (`server/events-feed.ts`). */
export const Events = z.object({
  events: z.array(
    z.object({
      /** This event's cursor. */
      cursor: z.string(),
      type: z.literal('page.committed'),
      at: z.string(),
      page: z.object({
        kind: z.string(),
        identifier: z.string(),
        address: z.string(),
        url: z.string(),
        name: z.string(),
        /** A paper's every identifier. */
        identifiers: z.array(z.string()).optional(),
      }),
      seq: z.number().int(),
      oid: z.string(),
      parent: z.string().nullable(),
      kind: z.string(),
      summary: z.string(),
      paths: z.array(z.string()),
      bot: z.boolean(),
      /** The page's first commit. */
      created: z.boolean(),
      /** A merge: the paper folded into this one. */
      merged: z.object({ identifier: z.string().nullable(), identifiers: z.array(z.string()) }).optional(),
    }),
  ),
  /** `after` for the next read. */
  next: z.string(),
  /** More are ready now. */
  more: z.boolean(),
});
