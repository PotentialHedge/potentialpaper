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

export const DemoAttachBody = z.object({
  paper: PaperIdentifier,
  url: z.url().max(2000),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
});

export const DemoRemoveQuery = z.object({
  scheme: PaperSchemeParam,
  value: z.string().min(1).max(300),
  id: SnapshotId,
});

export const DemoPointer = z.object({
  id: SnapshotId,
  title: z.string(),
  description: z.string().optional(),
  source: z.string(),
  commit: z.string(),
  root: z.string(),
});

export const DemoAttached = z.object({
  demo: DemoPointer,
  url: z.string(),
  files: z.number().int(),
  bytes: z.number().int(),
  /** The page's head after the change. */
  head: z.string().nullable(),
});

export const DemoRemoved = z.object({ head: z.string().nullable() });

const Oid = z.string().regex(/^[0-9a-f]{40}$/);

export const SectionEditBody = z.object({
  paper: PaperIdentifier,
  /** The commit the editor loaded, or `null` for a page with no repo yet. */
  baseOid: Oid.nullable(),
  /** From 1 in order; 0 is the whole community section. */
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
