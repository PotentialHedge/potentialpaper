import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { NOTE_KINDS, SUBMISSION_STATUSES, type FieldValue, type VenueForms } from '../lib/submissions';
import type { PdfPointer, ThumbnailPointer } from '@/server/pages/rules';
import { PAPER_ORIGINS } from '../server/paper-sources/types';
import { user } from './auth-schema';

export * from './auth-schema';

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`clock_timestamp()`);

/**
 * A person or bot on the site, one per confirmed Better Auth `user`, who owns identity (DESIGN.md §5).
 * What the public sees is here (§5.3): real names are optional, and showing the institution is a choice.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    /** Lower case; a placeholder `user-xxxxxx` until `profileCompletedAt`. */
    handle: text('handle').notNull(),
    realName: text('real_name'),
    /** Whether `institutions` is shown publicly. Asked explicitly in onboarding; false until then. */
    showInstitution: boolean('show_institution').notNull().default(false),
    /** When the person chose their handle and answered about their institution. */
    profileCompletedAt: timestamp('profile_completed_at', { withTimezone: true, mode: 'date' }),
    /**
     * Cache of the institutions of this account's **confirmed** `affiliations`, the sign-up address's
     * first, then by confirmation time; distinct. Written in the same transaction as the affiliation
     * (`server/affiliations.ts`).
     */
    institutions: text('institutions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** When the account's first institutional address was confirmed; `null` once none is. Gates writing. */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    isBot: boolean('is_bot').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('accounts_handle_key').on(t.handle),
    uniqueIndex('accounts_user_id_key')
      .on(t.userId)
      .where(sql`user_id is not null`),
  ],
);

export type Account = typeof accounts.$inferSelect;

/** The institutional addresses an account is verified through; written only by `server/affiliations.ts`. */
export const affiliations = pgTable(
  'affiliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Lower-cased. */
    email: text('email').notNull(),
    institutionName: text('institution_name').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    /** SHA-256 of the outstanding code, hex; null once confirmed. */
    codeHash: text('code_hash'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true, mode: 'date' }),
    /** Wrong codes against the outstanding one; a new code resets it. */
    codeAttempts: integer('code_attempts').notNull().default(0),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('affiliations_account_email_key').on(t.accountId, t.email),
    uniqueIndex('affiliations_verified_email_key')
      .on(t.email)
      .where(sql`verified_at is not null`),
    uniqueIndex('affiliations_primary_key')
      .on(t.accountId)
      .where(sql`is_primary`),
  ],
);

export type Affiliation = typeof affiliations.$inferSelect;

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  key: text('key').primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

/**
 * Domains admins have approved, on top of the generated `config/institution-domains.json`. Read on
 * every check (`server/institution-domains.ts`), so an approval needs no restart.
 */
export const institutionDomains = pgTable('institution_domains', {
  domain: text('domain').primaryKey(),
  name: text('name').notNull(),
  addedBy: uuid('added_by').references(() => accounts.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/**
 * Someone refused at sign-up asking for their institution to be added. Written only by
 * `server/institution-requests.ts`. **`email` is deleted once the decision has been mailed**: it is
 * kept only to tell the person the answer.
 */
export const institutionRequests = pgTable(
  'institution_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email'),
    domain: text('domain').notNull(),
    institutionName: text('institution_name').notNull(),
    website: text('website'),
    note: text('note'),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    decidedBy: uuid('decided_by').references(() => accounts.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('institution_requests_status_domain_idx').on(t.status, t.domain),
    uniqueIndex('institution_requests_pending_email_key')
      .on(t.email)
      .where(sql`status = 'pending'`),
    check('institution_requests_status_check', sql`${t.status} in ('pending', 'approved', 'rejected')`),
  ],
);

export type InstitutionRequest = typeof institutionRequests.$inferSelect;

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * A work, not a version: arXiv v1 to v5 and the published version share one row (DESIGN.md §3). Made
 * on the first visit to a valid identifier (`server/papers.ts`) or by a bulk import. Ids stay internal:
 * addresses use `paper_identifiers`.
 */
export const papers = pgTable(
  'papers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    /** Names as printed on the paper, in order. Empty while a paper is under anonymous review. */
    authors: jsonb('authors').$type<string[]>().notNull().default([]),
    abstract: text('abstract'),
    year: integer('year'),
    venue: text('venue'),
    /**
     * Where the row came from, and the licenses of what we copied (`paper-sources/types.ts`). `null` only
     * on rows from before these were kept whose source can't be told.
     */
    source: text('source', { enum: PAPER_ORIGINS }),
    metadataLicense: text('metadata_license'),
    abstractLicense: text('abstract_license'),
    /** The duplicate's survivor. Its identifiers still resolve, and redirect there. */
    mergedInto: uuid('merged_into').references((): AnyPgColumn => papers.id, { onDelete: 'set null' }),
    search: tsvector('search')
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', coalesce(abstract, '')), 'B')`,
      ),
    createdAt: createdAt(),
  },
  (t) => [
    index('papers_search_idx').using('gin', t.search),
    index('papers_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
    index('papers_merged_into_idx').on(t.mergedInto),
    check('papers_source_check', sql`${t.source} in ('arxiv', 'openalex', 'openreview')`),
  ],
);

export type Paper = typeof papers.$inferSelect;

/** The addresses of a paper. `value` is in the normal form of `lib/paper-ids.ts`. */
export const paperIdentifiers = pgTable(
  'paper_identifiers',
  {
    scheme: text('scheme', { enum: ['arxiv', 'doi', 'openreview'] }).notNull(),
    value: text('value').notNull(),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.scheme, t.value] }),
    index('paper_identifiers_paper_id_idx').on(t.paperId),
    check('paper_identifiers_scheme_check', sql`${t.scheme} in ('arxiv', 'doi', 'openreview')`),
  ],
);

/** Identifiers a source said do not exist, so a crawler cannot make us ask again and again. */
export const paperLookupMisses = pgTable(
  'paper_lookup_misses',
  {
    scheme: text('scheme').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scheme, t.value] })],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * The stable pseudonym in the commits of an account (DESIGN.md §4.4), such as `u_7k3xq2mf`. **Private:**
 * git shows only `id`, and this table is what ties it to a person. Deleting an account clears the link
 * and leaves history as it was.
 */
export const commitIdentities = pgTable(
  'commit_identities',
  {
    id: text('id').primaryKey(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('commit_identities_account_key').on(t.accountId)],
);

/**
 * A page's git repository: real blobs, trees and commits as rows (DESIGN.md §4.1). `oid` is the SHA-1 git
 * would compute, and `body` the object without git's `<type> <size>\0` header. Written only by
 * `server/pages/commit.ts`.
 */
export const pageObjects = pgTable(
  'page_objects',
  {
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    oid: bytea('oid').notNull(),
    type: text('type', { enum: ['blob', 'tree', 'commit'] }).notNull(),
    body: bytea('body').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.paperId, t.oid] }),
    check('page_objects_type_check', sql`${t.type} in ('blob', 'tree', 'commit')`),
  ],
);

/** The only mutable part of a repo: `refs/heads/main`. A paper nobody has edited has no row (§4.2). */
export const pageRefs = pgTable('page_refs', {
  paperId: uuid('paper_id')
    .primaryKey()
    .references(() => papers.id, { onDelete: 'cascade' }),
  head: bytea('head').notNull(),
});

/**
 * A projection: one row per commit on `main`, oldest first. `scripts/rebuild-page-projections.ts` makes
 * it again from the objects and `commit_identities`. **`account_id` is private**: public reads return
 * `author_id`, as the commit itself does.
 */
export const pageRevisions = pgTable(
  'page_revisions',
  {
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    oid: bytea('oid').notNull(),
    authorId: text('author_id').notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ['edit', 'revert'] }).notNull(),
    summary: text('summary').notNull(),
    paths: text('paths').array().notNull(),
    bytesDelta: integer('bytes_delta').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.paperId, t.seq] }),
    uniqueIndex('page_revisions_oid_key').on(t.paperId, t.oid),
    index('page_revisions_account_idx').on(t.accountId),
    check('page_revisions_kind_check', sql`${t.kind} in ('edit', 'revert')`),
  ],
);

/**
 * A projection: what a page says at its head, so that reading one never touches git objects (§4.5). The
 * Markdown is stored as written: rendering it to sanitized HTML at commit comes with the editor (Milestone 3).
 */
export const pageCurrent = pgTable('page_current', {
  paperId: uuid('paper_id')
    .primaryKey()
    .references(() => papers.id, { onDelete: 'cascade' }),
  head: bytea('head').notNull(),
  authorMarkdown: text('author_markdown'),
  communityMarkdown: text('community_markdown'),
  resources: jsonb('resources').$type<Record<string, unknown>>(),
  /** The page's `pdf.json`. */
  pdf: jsonb('pdf').$type<PdfPointer>(),
  /** The page's `author/thumbnail.json`. */
  thumbnail: jsonb('thumbnail').$type<ThumbnailPointer>(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

/**
 * The event outbox (§10): one row per commit, in the commit's transaction, for feeds, webhooks and
 * extensions to read. **Not a projection**, since consumers remember how far they have read, so a rebuild
 * leaves it alone. The payload is public, so it never holds an account id. `id`s are handed out before
 * commit, so a reader that keeps a cursor must allow for a lower id appearing late; per page, `seq` is exact.
 */
export const pageEvents = pgTable(
  'page_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('page_events_paper_seq_key').on(t.paperId, t.seq)],
);

/**
 * A picture of a hosted PDF's first page, for search results. Keyed by the PDF's SHA-256, as the bytes in
 * R2 are, so a page that points at the same PDF shares it. Written by `scripts/render-covers.ts`; a PDF
 * without a row has no cover yet.
 */
export const pdfCovers = pgTable('pdf_covers', {
  sha256: text('sha256').primaryKey(),
  /** The JPEG in R2. */
  url: text('url').notNull(),
  createdAt: createdAt(),
});

/**
 * A venue that publishes its reviews, such as a conference on OpenReview. `forms` says how to show each
 * kind of note it publishes (`lib/submissions.ts`), so the page knows no venue by name. Written by
 * imports (`server/import-reviews.ts`).
 */
export const venues = pgTable('venues', {
  /** The source and its id for the venue: `openreview:ICLR.cc/2027/Conference`. */
  id: text('id').primaryKey(),
  /** "ICLR 2027". */
  name: text('name').notNull(),
  url: text('url'),
  forms: jsonb('forms').$type<VenueForms>().notNull().default({}),
  createdAt: createdAt(),
});

/**
 * A paper's submission to a venue. A paper can have several: rejected at one venue, accepted at the next.
 * Imported, never edited on the site, so it is not part of the page's repo.
 */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    /** The source's id for it: an OpenReview forum id. */
    externalId: text('external_id').notNull(),
    number: integer('number'),
    /** `null` when the source doesn't say. */
    status: text('status', { enum: SUBMISSION_STATUSES }),
    /** As the venue words it: "Accept (Poster)". */
    decision: text('decision'),
    url: text('url'),
    /** When the source was read: its notes are as they stood then. */
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    uniqueIndex('submissions_venue_external_key').on(t.venueId, t.externalId),
    index('submissions_paper_id_idx').on(t.paperId),
    check(
      'submissions_status_check',
      sql.raw(`status in (${SUBMISSION_STATUSES.map((status) => `'${status}'`).join(', ')})`),
    ),
  ],
);

/**
 * What a venue published about a submission: a review, meta-review, decision or comment, as a thread by
 * `reply_to`. Only notes the source shows everyone are imported. Each keeps its license and source link,
 * since OpenReview's CC BY 4.0 needs both wherever one is shown (DESIGN.md §3).
 */
export const submissionNotes = pgTable(
  'submission_notes',
  {
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    /** The note it answers, by `external_id`; `null` when it answers the submission. */
    replyTo: text('reply_to'),
    kind: text('kind', { enum: NOTE_KINDS }).notNull(),
    /** The source's name for its kind, which picks its form: `Official_Review`. */
    invitation: text('invitation').notNull(),
    /** As the venue shows its writer: "Reviewer B3x7". */
    signature: text('signature').notNull(),
    content: jsonb('content').$type<Record<string, FieldValue>>().notNull(),
    license: text('license').notNull(),
    url: text('url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    modifiedAt: timestamp('modified_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.submissionId, t.externalId] }),
    check('submission_notes_kind_check', sql.raw(`kind in (${NOTE_KINDS.map((kind) => `'${kind}'`).join(', ')})`)),
  ],
);
