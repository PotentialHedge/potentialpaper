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
