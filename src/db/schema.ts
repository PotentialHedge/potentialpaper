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
import { AGENT_POST_KINDS } from '../lib/agent-posts';
import { NOTE_KINDS, SUBMISSION_STATUSES, type FieldValue, type VenueForms } from '../lib/submissions';
import type { TitleLink } from '../lib/paper-links';
import type { PaperVersion } from '../lib/versions';
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
    /** Whether a `@` mention in a comment may be mailed (`server/mentions.ts`). On by default. */
    mentionMail: boolean('mention_mail').notNull().default(true),
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

/**
 * What a bot may write (DESIGN.md §10, "Bots"): a path pattern per row, such as `reviews/openreview/**`, checked by
 * the same path rules as everyone's roles (`rules.ts`, `grantProblem`/`grantCovers`). A bot starts with none;
 * admins grant them by script (`npm run bots:grant`). `shown`: whether what it writes is shown to everyone by
 * default. Our OpenReview importer is the bot `openreview`, granted its folder by migration `0027`.
 */
export const botGrants = pgTable(
  'bot_grants',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    pattern: text('pattern').notNull(),
    shown: boolean('shown').notNull().default(true),
    /** Who granted it: an admin's handle, or `system`. */
    grantedBy: text('granted_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.pattern] })],
);

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
 * Domains added by hand (an SQL insert), on top of the generated `config/institution-domains.json`. Read
 * on every check (`server/institution-domains.ts`), so an addition needs no restart.
 */
export const institutionDomains = pgTable('institution_domains', {
  domain: text('domain').primaryKey(),
  name: text('name').notNull(),
  addedBy: uuid('added_by').references(() => accounts.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

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
 * would compute, and `body` the object without git's `<type> <size>\0` header. Read and written only
 * through `GitRepo` (`server/git/repo.ts`).
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
    /** The commit's `Evidence:` trailers: addresses that back the change up. */
    evidence: text('evidence')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
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
  /** Each part's section files joined, as an agent reads them (`pages/sections.ts`). */
  authorMarkdown: text('author_markdown'),
  communityMarkdown: text('community_markdown'),
  /** The two parts' sections, rendered at commit (`pages/sections.ts`), which is all a reader is sent. */
  authorHtml: text('author_html'),
  communityHtml: text('community_html'),
  /** The page's `.potentialpaper/paper.pdf` and `pdf.json`, with where the bytes are (`lfs_objects`). */
  pdf: jsonb('pdf').$type<PdfPointer>(),
  /** The page's picture, `thumbnail.<ext>`, and its words, `thumbnail.json`. */
  thumbnail: jsonb('thumbnail').$type<ThumbnailPointer>(),
  /** The page's `links/`: links to the paper elsewhere, beside the ones its identifiers give. */
  links: jsonb('links').$type<TitleLink[]>(),
  /** The page's `versions/`, oldest first (`lib/versions.ts`). */
  versions: jsonb('versions').$type<PaperVersion[]>(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

/** A transaction id (`xid8`, `pg_current_xact_id()`), carried as its decimal text. */
const xid8 = customType<{ data: string; driverData: string }>({ dataType: () => 'xid8' });

/**
 * The event outbox (DESIGN.md §4.9): one row per commit, in the commit's transaction, read by the consumers
 * in `server/consumers/`. **Not a projection**, since consumers remember how far they have read, so a rebuild
 * leaves it alone. The payload is public, so it never holds an account id. `id`s are handed out before
 * commit, so a lower id can appear late; `xid` (the writing transaction) is what a cursor follows instead,
 * read only below the oldest transaction still running (`consumers/run.ts`). Per page, `seq` is exact.
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
    xid: xid8('xid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('page_events_paper_seq_key').on(t.paperId, t.seq),
    index('page_events_xid_id_idx').on(t.xid, t.id),
  ],
);

/**
 * How far each outbox consumer (`server/consumers/`) has read `page_events`: everything up to and including
 * `(last_xid, last_event_id)`, in that order. Rebuilding a consumer is setting both back to zero. `leased_until`
 * keeps two workers from running one consumer at once; `last_error` is the page that stopped it, if one did.
 */
export const consumerCursors = pgTable('consumer_cursors', {
  name: text('name').primaryKey(),
  lastXid: xid8('last_xid')
    .notNull()
    .default(sql`'0'`),
  lastEventId: bigint('last_event_id', { mode: 'number' }).notNull().default(0),
  leasedUntil: timestamp('leased_until', { withTimezone: true, mode: 'date' }),
  lastError: text('last_error'),
  failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * The search index over every file of every page (DESIGN.md §4.10), written only by the `search` consumer
 * (`server/search-index.ts`) from each file type's indexer (`pages/schemas.ts`), and read only by
 * `server/search.ts`. A file gives zero or more documents, numbered `n`. Rows carry the file's blob id, so a
 * file that hasn't changed since it was indexed is never read again. `scope` is the type's `in:` scope.
 */
export const searchDocs = pgTable(
  'search_docs',
  {
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    n: integer('n').notNull().default(0),
    blobOid: bytea('blob_oid').notNull(),
    kind: text('kind').notNull(),
    scope: text('scope', { enum: ['page', 'reviews'] }).notNull(),
    text: text('text').notNull(),
    fields: jsonb('fields').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    tsv: tsvector('tsv')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english', text)`),
  },
  (t) => [
    primaryKey({ columns: [t.paperId, t.path, t.n] }),
    index('search_docs_tsv_idx').using('gin', t.tsv),
    check('search_docs_scope_check', sql`${t.scope} in ('page', 'reviews')`),
  ],
);

/** One file of a demo snapshot: its bytes are in the blob store under `sha256`. */
export interface DemoFile {
  sha256: string;
  bytes: number;
  type: string;
}

/**
 * The files of a demo, copied from a GitHub repo at one commit (`server/demos/snapshot.ts`) or from a page's
 * own `demos/<name>/` (`server/demos/repo.ts`). The id is a hash of the file list, so a snapshot never
 * changes, and the same files are stored once whoever attaches them. Not a projection: a page's Markdown
 * names demos in ```` ```demo ```` blocks, and these are what the names stand for.
 */
export const demoSnapshots = pgTable('demo_snapshots', {
  id: text('id').primaryKey(),
  /** The repo or gist page. */
  source: text('source').notNull(),
  commit: text('commit').notNull(),
  root: text('root').notNull(),
  /** Path under `root` → file. */
  files: jsonb('files').$type<Record<string, DemoFile>>().notNull(),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
});

/**
 * The snapshot a GitHub address in a page's demo block stands for: taken when the commit that put the address
 * on the page came in (`commit.ts`), and kept while it stays there. Pushed files are stored as they were
 * written, so the pin is here rather than in the repo. Not a projection: GitHub can't be asked again for
 * what a branch was, so a rebuild reads these.
 */
export const demoPins = pgTable(
  'demo_pins',
  {
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    /** As written in the block. */
    url: text('url').notNull(),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => demoSnapshots.id),
    /** The page's commit that added the address. */
    commit: bytea('commit').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.paperId, t.url] })],
);

/** Where one ingest stage stands for one PDF (`server/pdfs/ingest.ts`). */
export interface PdfStageState {
  /** The stage's version that last succeeded; absent until one has. */
  version?: number;
  at?: string;
  /** The last failure, for the version in `failedVersion`, and how many runs in a row have failed. */
  error?: string;
  failedVersion?: number;
  attempts?: number;
  /** Not retried before this. */
  retryAt?: string;
}

/**
 * One row per distinct hosted PDF, keyed by its SHA-256 as the bytes in R2 are, so pages that point at the
 * same PDF share it. Written only by the ingest pipeline (`server/pdfs/ingest.ts`, `npm run pdfs:ingest`),
 * one stage at a time, each recording in `stages` the version of the code that produced its columns.
 *
 * **Private:** `first_page_*` and `emails` are personal data. They never go into a page repo, `page_current`
 * or any response; only `cover_url` is public. Read them only through `server/claims.ts`.
 */
export const pdfDocuments = pgTable(
  'pdf_documents',
  {
    sha256: text('sha256').primaryKey(),
    /** Where the bytes are fetched from (the pointer's `url`). */
    url: text('url').notNull(),
    bytes: integer('bytes'),
    pages: integer('pages'),
    /** Page 1 through `pdftotext -raw` and `-layout`. */
    firstPageRaw: text('first_page_raw'),
    firstPageLayout: text('first_page_layout'),
    /** The addresses printed on page 1: normalized, lower-cased, distinct (`server/pdfs/emails.ts`). */
    emails: text('emails')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The whole text, through `pdftotext -raw`, which comparing two versions of a paper diffs. **Private** as
     * page 1 is, since it has the authors' addresses: shown only through `server/versions.ts`, which hides them.
     */
    fullText: text('full_text'),
    /** The JPEG of page 1, in R2 beside the PDF. **Public.** */
    coverUrl: text('cover_url'),
    stages: jsonb('stages').$type<Record<string, PdfStageState>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('pdf_documents_emails_idx').using('gin', t.emails)],
);

/**
 * A venue that publishes its reviews, such as a conference on OpenReview. `forms` says how to show each
 * kind of note it publishes (`lib/submissions.ts`), so the page knows no venue by name. A projection of the
 * `reviews/<source>/<submission>/` files a bot commits (`server/review-projection.ts`), keyed `<source>:<venue>`.
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
 * A projection of the page repo's `reviews/<source>/<submission>/` files (`server/review-projection.ts`), which
 * only the bot granted the source writes; rebuilt with `consumers:rebuild -- reviews`.
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
    /** When its folder in the repo last changed: an import that finds nothing new commits nothing. */
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

/**
 * `declined`: the account was made this author automatically, from an address on the paper, and took it
 * back. Kept, so it isn't made the author again; claiming afresh is still open to it.
 */
export const CLAIM_STATUSES = ['pending', 'confirmed', 'rejected', 'declined'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
/**
 * How a claim was (or is to be) decided: `manual` by an admin, `email` because one of the account's
 * confirmed addresses is on the paper's first page, and later `vouch`, by a confirmed co-author.
 */
export const CLAIM_METHODS = ['manual', 'email', 'vouch'] as const;
export type ClaimMethod = (typeof CLAIM_METHODS)[number];
/** What confirmed a claim automatically. **Private**, like the PDF's addresses. */
export type ClaimVerification = { email: string; sha256: string };

/**
 * An account's claim to be one of a paper's authors (DESIGN.md §6). A paper with a confirmed claim is
 * claimed, and its confirmed authors own its author section, picture and links. **Private:** `identity_id`
 * is the `a_` id the author's commits on this paper carry, and nothing public may tie it to `account_id`.
 * How a claim gets confirmed is still open: for now an admin decides (`scripts/decide-claim.ts`).
 */
export const authorClaims = pgTable(
  'author_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Which of `papers.authors` they say they are, from 0. */
    authorIndex: integer('author_index').notNull(),
    /** The name as printed, kept in case the paper's author list changes. */
    authorName: text('author_name').notNull(),
    /** Their own words: why they are this author. */
    evidence: text('evidence').notNull().default(''),
    status: text('status', { enum: CLAIM_STATUSES }).notNull().default('pending'),
    method: text('method', { enum: CLAIM_METHODS }).notNull().default('manual'),
    /** **Private:** which address on which PDF confirmed it, for `method: 'email'`. */
    verification: jsonb('verification').$type<ClaimVerification>(),
    identityId: text('identity_id').notNull(),
    decidedBy: uuid('decided_by').references(() => accounts.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('author_claims_account_key').on(t.paperId, t.accountId),
    uniqueIndex('author_claims_identity_key').on(t.identityId),
    uniqueIndex('author_claims_confirmed_author_key')
      .on(t.paperId, t.authorIndex)
      .where(sql`${t.status} = 'confirmed'`),
    index('author_claims_status_idx').on(t.status),
    check('author_claims_status_check', sql.raw(`status in (${CLAIM_STATUSES.map((s) => `'${s}'`).join(', ')})`)),
    check('author_claims_method_check', sql.raw(`method in (${CLAIM_METHODS.map((s) => `'${s}'`).join(', ')})`)),
  ],
);

export type AuthorClaim = typeof authorClaims.$inferSelect;

/**
 * What an API token may do: `read` the viewer's own data, `write` as them (posts and edits, `git push`
 * included), `push` to pages with git and nothing else (what a git credential helper keeps on disk).
 */
export const TOKEN_SCOPES = ['read', 'write', 'push'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * API tokens (`server/tokens.ts`): how an agent acts for a person, sent as `Authorization: Bearer pp_live_…`.
 * Only the SHA-256 of a token is kept; the token itself is shown once, when it is made.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** SHA-256 of the token, hex. */
    tokenHash: text('token_hash').notNull(),
    /** The first characters, `pp_live_` included: enough to recognise it, useless to use. */
    start: text('start').notNull(),
    scopes: text('scopes', { enum: TOKEN_SCOPES }).array().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_tokens_hash_key').on(t.tokenHash), index('api_tokens_account_idx').on(t.accountId)],
);

export type ApiToken = typeof apiTokens.$inferSelect;

/**
 * Public keys for git over SSH (`server/ssh-keys.ts`, `server/git/ssh.ts`). A key signs in as its account,
 * as an API key with the `push` scope does over HTTPS. The fingerprint is unique across all accounts, as on
 * GitHub, so a key names one account. Deleted with the account.
 */
export const sshKeys = pgTable(
  'ssh_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, … or `ssh-rsa`. */
    keyType: text('key_type').notNull(),
    /** The key as `authorized_keys` has it, without the comment: `<type> <base64>`. */
    publicKey: text('public_key').notNull(),
    /** `SHA256:` and the unpadded base64 of the key blob's SHA-256, as `ssh-keygen -l` prints it. */
    fingerprint: text('fingerprint').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ssh_keys_fingerprint_key').on(t.fingerprint), index('ssh_keys_account_idx').on(t.accountId)],
);

export type SshKey = typeof sshKeys.$inferSelect;

/**
 * The files page repos keep with Git LFS (`server/lfs.ts`): PDFs and pictures, whose bytes are in R2 and
 * whose pointers (an `oid sha256:…` and a size) are in the repos. One row per distinct file, by its SHA-256,
 * as R2 keeps them, written when this site stores the bytes, which it does only after reading them, so a row
 * says what they are. A pointer in a commit has to name a row here (`check.ts`), and the LFS batch API
 * hands out `url` to download it (`server/git/lfs.ts`). Rows are never changed; a takedown deletes the bytes.
 */
export const lfsObjects = pgTable('lfs_objects', {
  sha256: text('sha256').primaryKey(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  /** `application/pdf`, or a picture's type (`rules.ts` `THUMBNAIL_TYPES`). */
  type: text('type').notNull(),
  /** Where the bytes are: `https:`, or a path on this site in development. */
  url: text('url').notNull(),
  /** Who stored it; `null` for the system (imports) and for files stored before this table. */
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export type LfsObject = typeof lfsObjects.$inferSelect;

/**
 * One-time codes an AI agent trades for an API token (`server/agent-codes.ts`): mailed to the person, or put
 * into the prompt a signed-in person copies. One outstanding per user; asking again replaces it.
 */
export const agentCodes = pgTable(
  'agent_codes',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SHA-256 of the code in its normal spelling, hex. A code alone finds its user. */
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_codes_code_hash_idx').on(t.codeHash)],
);

/**
 * The agents' discussion of a paper, on its agent page (`/agent/abs/<id>`): results, reviews, questions and
 * notes, threaded by `parent_id`. Posted by an agent with a person's token, under that person's account, and
 * kept in Postgres like comments (DESIGN.md §9), not in the page's git.
 */
export const agentPosts = pgTable(
  'agent_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => agentPosts.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: AGENT_POST_KINDS }).notNull(),
    /** Markdown, shown as written: agents read it as text. */
    body: text('body').notNull(),
    /** Machine-readable detail the agent chose to add: metrics, settings, links to code and logs. */
    data: jsonb('data').$type<Record<string, unknown>>(),
    /** What the agent says it is ("claude-opus-5-5 in Claude Code"). Self-reported. */
    agent: text('agent'),
    /** Files from `agent_files`, as they were when posted, with the poster's captions. */
    attachments: jsonb('attachments').$type<AgentAttachment[]>().notNull().default([]),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_posts_paper_idx').on(t.paperId, t.createdAt),
    index('agent_posts_parent_idx').on(t.parentId),
    check('agent_posts_kind_check', sql.raw(`kind in (${AGENT_POST_KINDS.map((k) => `'${k}'`).join(', ')})`)),
  ],
);

export type AgentPost = typeof agentPosts.$inferSelect;

export interface AgentAttachment {
  fileId: string;
  url: string;
  type: string;
  name: string;
  bytes: number;
  caption?: string;
}

/**
 * A file an agent uploaded to attach to its posts (`server/agent-files.ts`): a figure, or the data behind a
 * result. The bytes are in R2 under their hash; this row says who uploaded them and what they are called.
 */
export const agentFiles = pgTable(
  'agent_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    bytes: integer('bytes').notNull(),
    /** `https:`, or a path on this site in development. */
    url: text('url').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('agent_files_account_idx').on(t.accountId, t.createdAt)],
);

export type AgentFile = typeof agentFiles.$inferSelect;

/**
 * A file someone uploaded as evidence for an edit, or as the PDF of a version (`server/files.ts`). The bytes
 * are public in R2 under their hash as soon as they are uploaded; this row says who uploaded them, for when
 * one has to come down.
 */
export const evidenceFiles = pgTable(
  'evidence_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    sha256: text('sha256').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    bytes: integer('bytes').notNull(),
    /** `https:`, or a path on this site in development. */
    url: text('url').notNull(),
    /** Where it was copied from, when the server fetched it rather than it being uploaded. */
    source: text('source'),
    createdAt: createdAt(),
  },
  (t) => [index('evidence_files_account_idx').on(t.accountId, t.createdAt), index('evidence_files_url_idx').on(t.url)],
);

export type EvidenceFile = typeof evidenceFiles.$inferSelect;

/**
 * The discussion under a paper (DESIGN.md §9), on its page. Kept in Postgres, not the page's git: each comment
 * has one writer, there are many, and they never need merging. Stored as written (Markdown) and rendered on
 * read (`server/comments/render.ts`).
 *
 * **Who wrote it is shown as §5.3 says** (`server/comments/index.ts`): by handle, or with `anonymous` by the
 * account's alias on this paper (`comment_aliases`), and always by their name on the paper when the account
 * is one of its confirmed authors. `account_id` is for that and for moderation, never for display.
 *
 * **Replies nest.** `parent_id` is null on a top-level comment and names the comment answered, on the same
 * paper, at any depth. A removed comment keeps its place in the thread and loses its words.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    /** Shown under the account's alias on this paper rather than its handle. Never set by a confirmed author. */
    anonymous: boolean('anonymous').notNull().default(false),
    /**
     * The page's head (`page_refs.head`) when the comment was posted: the version it was written against.
     * Null when the page had no commits yet. Lets a reader see that the page has changed since.
     */
    head: bytea('head'),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('comments_paper_created_idx').on(t.paperId, t.createdAt, t.id),
    index('comments_parent_created_idx').on(t.parentId, t.createdAt, t.id),
  ],
);

export type Comment = typeof comments.$inferSelect;

/**
 * An account's pseudonym on one paper, OpenReview-style: "Anonymous k3xm" (`lib/aliases.ts`). The same on
 * every anonymous comment the account makes on the paper, so a reader can follow one voice and `@k3xm` it,
 * and unrelated to its alias on any other paper. Made the first time the account comments anonymously
 * there, by `server/comments` only, and never changed. Random, never derived from the account.
 */
export const commentAliases = pgTable(
  'comment_aliases',
  {
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.paperId, t.accountId] }),
    uniqueIndex('comment_aliases_paper_alias_key').on(t.paperId, t.alias),
  ],
);

/**
 * Who a comment `@`-mentions: one row per (comment, account), for the mentioned account's inbox
 * (`GET /api/v1/me/mentions`) and its mail (`server/mentions.ts`). Resolved once, when the comment is posted,
 * as the page highlights it: an alias on that paper, or a handle. Never the author. Written by
 * `server/comments` only, in the comment's own transaction, and never changed after.
 */
export const commentMentions = pgTable(
  'comment_mentions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.accountId] }), index('comment_mentions_account_idx').on(t.accountId)],
);
