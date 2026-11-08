import { z } from 'zod';
import { REAL_NAME_MAX } from '@/lib/profile';
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
});

export const PageCommitted = z.object({
  /** The page's head after the change. */
  head: z.string().nullable(),
  /** Whether it was merged with edits made since its base. */
  merged: z.boolean(),
  changed: z.boolean(),
});

export const RenderBody = z.object({ content: z.string().max(256 * 1024) });
export const Rendered = z.object({ html: z.string() });

export const RevertBody = z.object({
  paper: PaperIdentifier,
  oid: Oid,
  summary: z.string().max(1000).optional(),
});

export const LinksBody = z.object({
  paper: PaperIdentifier,
  links: z.array(z.object({ label: z.string().max(100), url: z.string().max(2000) })).max(50),
});

/** The picture's words, sent beside the image in a multipart form. */
export const ThumbnailFields = z.object({
  scheme: PaperSchemeParam,
  value: z.string().min(1).max(300),
  alt: z.string().max(1000).optional(),
  caption: z.string().max(1000).optional(),
});

export const PaperQuery = z.object({ scheme: PaperSchemeParam, value: z.string().min(1).max(300) });

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
      status: z.enum(['pending', 'confirmed', 'rejected']),
      /** How it was decided: `email` when an address of the claimant's on the paper confirmed it at once. */
      method: z.enum(['manual', 'email', 'vouch']),
      evidence: z.string(),
    })
    .nullable(),
});
