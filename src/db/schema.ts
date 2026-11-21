import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { AGENT_POST_KINDS } from '../lib/agent-posts';
import { PAGE_KINDS } from '../lib/kinds';
import { NOTE_KINDS, SUBMISSION_STATUSES, type FieldValue, type VenueForms } from '../lib/submissions';
import type { Bins, ScoreGroup, StatOutcome } from '../lib/scope-stats';
import type { TitleLink } from '../lib/paper-links';
import type { PaperVersion } from '../lib/versions';
import type { AuthorPanel } from '../lib/plugins/author-plugins';
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
    /** A few lines about the person, in Markdown with TeX, shown on their page as its abstract. Public when set. */
    bio: text('bio'),
    /** The person's links on their page (`lib/profile.ts`): an https homepage, an ORCID iD, a Scholar profile. */
    homepage: text('homepage'),
    orcid: text('orcid'),
    scholar: text('scholar'),
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
    /** Whether edits and comments on followed papers may be mailed (`server/follows.ts`). On by default. */
    followMail: boolean('follow_mail').notNull().default(true),
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
    /** The kind of page the pattern applies to (`lib/kinds.ts`): `reviews/openreview/**` on papers, `venue.json` on venues. */
    kind: text('kind', { enum: PAGE_KINDS }).notNull().default('paper'),
    pattern: text('pattern').notNull(),
    shown: boolean('shown').notNull().default(true),
    /** Who granted it: an admin's handle, or `system`. */
    grantedBy: text('granted_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.kind, t.pattern] })],
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
 * Every page of every kind (`lib/kinds.ts`): a paper, a venue, a topic, an organisation or a person. A page is a
 * repo (DESIGN.md §4), and every table of the page store is keyed by its id first (`page_objects`, `page_refs`,
 * …, §4.11). **A paper's page id is its paper id**, and its row is made with the paper by a trigger
 * (`papers_page_insert`, migration `0032`), so that it holds whatever wrote the paper; deleting the paper deletes
 * it, and with it the repo. Other kinds' pages are made by `server/pages/kinds.ts`'s `createPage`. `key` is what
 * the kind's address names (`iclr/2027`, a topic's slug, a handle); a paper's is its id, as its addresses are
 * `paper_identifiers`.
 */
export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: PAGE_KINDS }).notNull(),
    key: text('key').notNull(),
    /**
     * A topic merged into another (`handoffs/pages.md` Phase 5, `server/topic-pages.ts`): its page and history stay, its
     * address and identifier lead to the page it was merged into, and nobody commits to it again.
     */
    mergedInto: uuid('merged_into').references((): AnyPgColumn => pages.id, { onDelete: 'set null' }),
    /** Unique viewers, one a day each (`server/view-counter.ts`). Written only there. */
    viewCount: integer('view_count').notNull().default(0),
    /** The number in the page's short link, `/s/<n>`, its preview image and its badge (`server/share.ts`). */
    shortId: serial('short_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('pages_kind_key').on(t.kind, t.key),
    uniqueIndex('pages_short_id_key').on(t.shortId),
    index('pages_merged_into_idx').on(t.mergedInto),
    check('pages_kind_check', sql.raw(`kind in (${PAGE_KINDS.map((kind) => `'${kind}'`).join(', ')})`)),
  ],
);

export type Page = typeof pages.$inferSelect;

/**
 * Where a page's old address leads (`handoffs/pages.md` Phases 3 and 5): a user page is keyed by its account's handle,
 * so a changed handle moves the page's key and leaves its old key here; a renamed topic leaves its old slug. `/u/<old>`
 * and `user:<old>` (`/t/<old>`, `topic:<old>`) then still find the page. A user's is written only by the triggers on
 * `accounts` (migration `0037`), so every writer of a handle leaves one, and deleted when another account takes the old
 * handle; a topic's by `renameTopic` (`server/topic-pages.ts`), deleted when a new topic takes the old slug.
 */
export const pageRedirects = pgTable(
  'page_redirects',
  {
    kind: text('kind', { enum: PAGE_KINDS }).notNull(),
    key: text('key').notNull(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] }), index('page_redirects_page_idx').on(t.pageId)],
);

/**
 * A page's git repository: real blobs, trees and commits as rows (DESIGN.md §4.1). `oid` is the SHA-1 git
 * would compute, and `body` the object without git's `<type> <size>\0` header. Read and written only
 * through `GitRepo` (`server/git/repo.ts`).
 */
export const pageObjects = pgTable(
  'page_objects',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    oid: bytea('oid').notNull(),
    type: text('type', { enum: ['blob', 'tree', 'commit'] }).notNull(),
    body: bytea('body').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.oid] }),
    check('page_objects_type_check', sql`${t.type} in ('blob', 'tree', 'commit')`),
  ],
);

/** The only mutable part of a repo: `refs/heads/main`. A paper nobody has edited has no row (§4.2). */
export const pageRefs = pgTable('page_refs', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
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
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
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
    primaryKey({ columns: [t.pageId, t.seq] }),
    uniqueIndex('page_revisions_oid_key').on(t.pageId, t.oid),
    index('page_revisions_account_idx').on(t.accountId),
    check('page_revisions_kind_check', sql`${t.kind} in ('edit', 'revert')`),
  ],
);

/**
 * A projection: what a page says at its head, so that reading one never touches git objects (§4.5). The
 * Markdown is stored as written: rendering it to sanitized HTML at commit comes with the editor (Milestone 3).
 */
export const pageCurrent = pgTable('page_current', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  head: bytea('head').notNull(),
  /**
   * Each part's section files joined, as an agent reads them (`pages/sections.ts`). `author_*` holds the owners'
   * part of any kind (`owners/`, `lib/kinds.ts`).
   */
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
  /** A paper's `owners/plugins.json`: the plugins' panels its authors let into the author section, if it parses. */
  authorPlugins: jsonb('author_plugins').$type<AuthorPanel[]>(),
  /**
   * A page of another kind: its kind file as it parses (`venue.json`, …, `lib/kinds.ts`), or `null` if it has none
   * or it doesn't parse, and the name it shows (`pageName`). A paper's are `null`: its title is `papers.title`.
   */
  kindFile: jsonb('kind_file').$type<Record<string, unknown>>(),
  name: text('name'),
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
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    xid: xid8('xid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('page_events_page_seq_key').on(t.pageId, t.seq), index('page_events_xid_id_idx').on(t.xid, t.id)],
);

/**
 * The labeled links of every page (DESIGN.md §8), one row per line of a part's `links.jsonl`, written only by the
 * `links` consumer (`server/page-links.ts`) and rebuildable from the repos. It answers "what links here" on a page
 * of any kind: `target` is the identifier as the line names it, in normal form, and `target_page_id` the page it
 * named when the line was indexed, if there was one then. `origin` is the part the line is in: the owners'
 * (`owners/`) or `community`.
 */
export const pageLinks = pgTable(
  'page_links',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    linkId: text('link_id').notNull(),
    line: integer('line').notNull(),
    target: text('target').notNull(),
    /** The target's kind, or `web` for an address elsewhere (a person's homepage, `lib/labeled-links.ts`). */
    targetKind: text('target_kind', { enum: [...PAGE_KINDS, 'web'] }).notNull(),
    targetPageId: uuid('target_page_id').references(() => pages.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    origin: text('origin', { enum: ['owners', 'community'] }).notNull(),
    note: text('note'),
    fromAnchor: text('from_anchor'),
    toAnchor: text('to_anchor'),
    evidence: text('evidence'),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.path, t.linkId] }),
    index('page_links_target_idx').on(t.target),
    index('page_links_target_page_idx').on(t.targetPageId),
  ],
);

/**
 * What each paper says it belongs to, by public name: a submission's venue (`via` `submission`, `source`
 * `openreview:ICLR.cc/2027/Conference`), a topic it links to (`via` the label, `source` `topic:<slug>`), or an
 * institution's email domain (`via` `affiliation`, `source` `domain:ethz.ch`, and every domain above the address's:
 * a confirmed author who shows their institution, weight 1, or an address printed on page 1, weight 0.5). Written by
 * the `members` consumer (`server/page-members.ts`) from the paper's files and, for affiliations, from
 * `author_claims`, `affiliations` and `pdf_documents` (`server/org-members.ts`), whether or not a page of that name
 * exists yet, so `page_members` can be joined again whenever one appears.
 */
export const pageMemberSources = pgTable(
  'page_member_sources',
  {
    paperId: uuid('paper_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    via: text('via').notNull(),
    source: text('source').notNull(),
    /** How sure it is: 1, or less for a source that counts for less than certain (an address printed on page 1). */
    weight: doublePrecision('weight').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.paperId, t.via, t.source] }), index('page_member_sources_source_idx').on(t.source)],
);

/**
 * Papers whose affiliation sources (`page_member_sources` with `via` `affiliation`) are due again, because something
 * they come from changed outside the paper's repo: a claim confirmed or withdrawn, an address confirmed or removed, an
 * account's `show_institution`, the addresses read off a PDF. Filled by triggers on those tables (migration `0038`),
 * emptied by the worker's `org-members` task (`server/org-members.ts`).
 */
export const orgMembersDue = pgTable('org_members_due', {
  /** A paper's page id; no foreign key, since the triggers fire while a paper is being deleted too. */
  paperId: uuid('paper_id').primaryKey(),
  markedAt: timestamp('marked_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * The names a scope (a venue, topic or org page) answers to: its own identifier (`venue:iclr/2027`) and its kind
 * file's `sources`. Written by the `members` consumer.
 */
export const pageScopeNames = pgTable(
  'page_scope_names',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.name] }), index('page_scope_names_name_idx').on(t.name)],
);

/** A scope's parents, by identifier (`lib/kinds.ts`'s `parentsOf`): an edition's series, a topic's broader topics. */
export const pageParents = pgTable(
  'page_parents',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    parent: text('parent').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.parent] })],
);

/**
 * The papers of every scope (`handoffs/pages.md`): a venue's through their submissions, a topic's through links,
 * an org's through its members' confirmed claims and the domains printed on page 1 (`via` `affiliation` for both, so
 * nothing public tells the two apart). Every list, count, statistic and plugin query above the paper reads
 * this table, rolled up through `page_ancestors`. Written only by the `members` consumer; `weight` is for later
 * sources that count for less than certain (a domain printed on page 1).
 */
export const pageMembers = pgTable(
  'page_members',
  {
    scopePageId: uuid('scope_page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    via: text('via').notNull(),
    weight: doublePrecision('weight').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.scopePageId, t.paperId, t.via] }), index('page_members_paper_idx').on(t.paperId)],
);

/**
 * The closure of `page_parents` over the pages they name: every ancestor of a scope, at its shortest depth, so a
 * roll-up (a series' papers are its editions', a topic's include its narrower topics') is one join. Written by
 * the `members` consumer.
 */
export const pageAncestors = pgTable(
  'page_ancestors',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    ancestorId: uuid('ancestor_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.ancestorId] }), index('page_ancestors_ancestor_idx').on(t.ancestorId)],
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
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
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
    primaryKey({ columns: [t.pageId, t.path, t.n] }),
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
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** As written in the block. */
    url: text('url').notNull(),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => demoSnapshots.id),
    /** The page's commit that added the address. */
    commit: bytea('commit').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.url] })],
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
    /** The keywords its authors gave the source (OpenReview's), from `submission.json`; topic suggestions match them. */
    keywords: text('keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
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
 * confirmed addresses is on the paper's first page, and `vouch` by a confirmed co-author (`decided_by`).
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

/** What a page claim's status can be: waiting, confirmed or turned down. Stepping down removes the row. */
export const PAGE_CLAIM_STATUSES = ['pending', 'confirmed', 'rejected'] as const;
export type PageClaimStatus = (typeof PAGE_CLAIM_STATUSES)[number];

/**
 * An account's claim to be one of the owners of a page above the paper (`handoffs/pages.md`): for now a venue's
 * organisers, who write its `owners/` and its `venue.json`. Built on the author claim flow (`server/claims.ts`),
 * with the page as what is claimed, and confirmed by an admin (`npm run claims:decide`). An organiser of a series
 * also organises its editions (`server/page-claims.ts`). Organising is a public role, so an organiser's commits carry
 * their own `u_` identity, not a per-claim one.
 */
export const pageClaims = pgTable(
  'page_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Their own words: who they are at the venue, and where that can be checked. */
    evidence: text('evidence').notNull().default(''),
    status: text('status', { enum: PAGE_CLAIM_STATUSES }).notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => accounts.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('page_claims_account_key').on(t.pageId, t.accountId),
    index('page_claims_status_idx').on(t.status),
    check('page_claims_status_check', sql.raw(`status in (${PAGE_CLAIM_STATUSES.map((s) => `'${s}'`).join(', ')})`)),
  ],
);

export type PageClaim = typeof pageClaims.$inferSelect;

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

/**
 * Who looked at a page today, so that a visitor counts once a day (`server/view-counter.ts`). `visitor` is an HMAC
 * of the UTC day and the account or client network under a server secret: it cannot be reversed to an address, and,
 * the day being inside it, cannot link one day's visitor to the next. Only today's and yesterday's rows are kept;
 * `pages.view_count` is what lasts. A cache of reads, not a source of truth, so it has no foreign keys and can never
 * take a lock on a row anything else holds. A paper's page id is the paper's id, so this covers every kind.
 */
export const pageViews = pgTable(
  'page_views',
  {
    pageId: uuid('page_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    visitor: text('visitor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.day, t.visitor] }), index('page_views_day_idx').on(t.day)],
);

/**
 * How many visitors read one page and then another (`server/view-counter.ts`): unique per visitor per day per ordered
 * pair, summed, like `view_count`. Only the count is kept, never who or when, so nothing here is any one person's
 * reading. The signal for related papers ("readers of this also read"), read by `GET /transitions`. No foreign keys,
 * like `page_views`.
 */
export const pageTransitions = pgTable(
  'page_transitions',
  {
    fromPageId: uuid('from_page_id').notNull(),
    toPageId: uuid('to_page_id').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.fromPageId, t.toPageId] }), index('page_transitions_to_idx').on(t.toPageId)],
);

/**
 * Who went from one page to another today, so a visitor counts once a day per pair. `visitor` is an HMAC of the day,
 * the visitor and the pair, so a row cannot be joined to `page_views` or to the same visitor's other pairs. Only the
 * last two days' rows are kept.
 */
export const pageTransitionVisits = pgTable(
  'page_transition_visits',
  {
    day: date('day', { mode: 'string' }).notNull(),
    visitor: text('visitor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.visitor] })],
);

/**
 * A page's analytics, per UTC day (`server/page-analytics.ts`), for its owners only: `metric` is `views` (unique
 * visitors, as `pages.view_count`), `git` (clones and pulls, unique per visitor), `agent` (reads of its agent page,
 * unique per visitor), or `time:<bucket>` (how long a visitor kept it open, `TIME_BUCKETS`). Totals only, never who.
 * No foreign keys, like `page_views`.
 */
export const pageDailyCounts = pgTable(
  'page_daily_counts',
  {
    pageId: uuid('page_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.day, t.metric] })],
);

/**
 * How many signed-in visitors of each institution read a page in a UTC month (the month's first day), each counted
 * once a month (`page_month_visitors`). Shown to the page's owners only for institutions with enough visitors that
 * none of them can be told apart (`MIN_INSTITUTION_VISITORS`).
 */
export const pageInstitutionCounts = pgTable(
  'page_institution_counts',
  {
    pageId: uuid('page_id').notNull(),
    month: date('month', { mode: 'string' }).notNull(),
    institution: text('institution').notNull(),
    visitors: integer('visitors').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.month, t.institution] })],
);

/**
 * Who has been counted for `page_institution_counts` this month: an HMAC of the month, the account and the page, as
 * `page_views`'s. Only this and last month's rows are kept.
 */
export const pageMonthVisitors = pgTable(
  'page_month_visitors',
  {
    month: date('month', { mode: 'string' }).notNull(),
    visitor: text('visitor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.month, t.visitor] })],
);

/**
 * Who follows (stars) which paper (`server/follows.ts`): followers are mailed when the paper's page is edited or
 * someone comments on it. A confirmed author follows their paper from the moment their claim is confirmed, and can
 * unfollow it like anyone else. **Private:** only the count is public, never who.
 */
export const paperFollows = pgTable(
  'paper_follows',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.paperId] }), index('paper_follows_paper_idx').on(t.paperId)],
);

/**
 * Each account's `settings.json` (`lib/settings/`, DESIGN.md §10): the user layer over the defaults and the site
 * layer. The **text** is kept as written, JSONC with its comments and key order, and parsed when read; a value that
 * doesn't fit its setting reads as the layer below. Holds only what differs from the layers below. Preferences
 * only: anything the site merely remembers stays out of it. **Private.**
 */
export const userSettings = pgTable('user_settings', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  doc: text('doc').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * The site layer of settings (`lib/settings/`): one row, `id = 1`, whose JSONC text sits between the defaults and
 * every user's document. Admins edit it by script (`npm run settings:site`), so it changes without a deploy.
 */
export const siteSettings = pgTable(
  'site_settings',
  {
    id: smallint('id').primaryKey().default(1),
    doc: text('doc').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [check('site_settings_one_row', sql`${t.id} = 1`)],
);

/**
 * A plugin's files at one commit (`handoffs/plugins.md` Phase 2, DESIGN.md §10), copied once from GitHub when it is
 * first installed, as demos are (`server/plugins/snapshot.ts`): the bytes are stored by SHA-256 with demos', and the
 * manifest was checked when the copy was taken. Served at `<host>.<content domain>/<commit>/…`, where `host` is a
 * hash of the plugin id (`server/plugins/serve.ts`).
 */
export const pluginSnapshots = pgTable(
  'plugin_snapshots',
  {
    /** The source's key, without its ref: `github:<owner>/<repo>[/<folder>]` (`lib/plugins/sources.ts`). */
    source: text('source').notNull(),
    commit: text('commit').notNull(),
    pluginId: text('plugin_id').notNull(),
    /** The label of the plugin's host, from its id. */
    host: text('host').notNull(),
    /** The manifest as it was checked (`lib/plugins/manifest.ts`'s `PluginManifest`). */
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    /** The manifest's warnings, kept to show its author. */
    warnings: jsonb('warnings').$type<string[]>().notNull(),
    /** Path under the plugin's folder → file. */
    files: jsonb('files').$type<Record<string, DemoFile>>().notNull(),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.commit] }),
    uniqueIndex('plugin_snapshots_host_commit').on(t.host, t.commit),
  ],
);

/**
 * The commit a plugin source's ref (a tag, branch, or `''` for the default branch) named when it was first installed.
 * Kept until someone asks for an update, so a moving branch doesn't change what runs: updates are explicit.
 */
export const pluginRefs = pgTable(
  'plugin_refs',
  {
    source: text('source').notNull(),
    ref: text('ref').notNull(),
    commit: text('commit').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.source, t.ref] })],
);

/**
 * Consent, kept out of settings.json (DESIGN.md §10): which plugin, at which commit, an account let run with which
 * permissions and network origins. A plugin whose manifest asks for anything its grant lacks shows an approval
 * prompt instead of running.
 */
export const userPluginGrants = pgTable(
  'user_plugin_grants',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    pluginId: text('plugin_id').notNull(),
    /** The commit approved. */
    sha: text('sha').notNull(),
    permissions: text('permissions').array().notNull(),
    network: text('network').array().notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.pluginId] })],
);

/** A plugin's small state for one account (`storage.get`/`storage.set`): one JSON object, at most 64 KB. */
export const userPluginStorage = pgTable(
  'user_plugin_storage',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    pluginId: text('plugin_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.pluginId] })],
);

/**
 * The keys that sign plugins' identity tokens (`server/plugins/identity.ts`, `handoffs/plugins.md` Phase 5): ES256
 * key pairs as JWKs. The newest unretired key signs; every unretired key is published at `/.well-known/jwks.json`, so
 * a backend verifies tokens across a rotation. The first is made on first use; `npm run identity:keys` rotates and
 * retires them.
 */
export const identityKeys = pgTable('identity_keys', {
  kid: text('kid').primaryKey(),
  alg: text('alg').notNull(),
  privateJwk: jsonb('private_jwk').$type<Record<string, string>>().notNull(),
  publicJwk: jsonb('public_jwk').$type<Record<string, string>>().notNull(),
  createdAt: createdAt(),
  /** When it stopped being published; tokens it signed no longer verify. */
  retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
});

/**
 * Score statistics of every scope (`handoffs/plugins.md` Phase 4, data for plugins A), per `(scope, venue, field)`:
 * every submission's mean over its reviews for a score field of the venue's review forms, sorted, with bins and the
 * split by outcome (`lib/scope-stats.ts`). Rolled up like membership. Written only by `server/scope-stats.ts`, from
 * `submissions`, `submission_notes` and `page_members`; `consumers:rebuild -- scope-stats` starts it over.
 */
export const scopeStats = pgTable(
  'scope_stats',
  {
    scopePageId: uuid('scope_page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** `<source>:<venue id>`, as `venues.id`. */
    venueId: text('venue_id').notNull(),
    /** The field's key in the venue's forms: `rating`. */
    field: text('field').notNull(),
    label: text('label').notNull(),
    /** The field's place among the venue's: the form's summary first, then its order. */
    position: integer('position').notNull(),
    min: doublePrecision('min'),
    max: doublePrecision('max'),
    count: integer('count').notNull(),
    values: doublePrecision('values').array().notNull(),
    bins: jsonb('bins').$type<Bins>().notNull(),
    byStatus: jsonb('by_status').$type<Record<StatOutcome, ScoreGroup>>().notNull(),
    /** Whether the venue has decided on any submission yet, for `plugins.venueStats.hideUntil`. */
    decisionsOut: boolean('decisions_out').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scopePageId, t.venueId, t.field] })],
);

/**
 * Each scope's last change and its pending recomputation of `scope_stats`. A change to a member paper's reviews or to
 * membership marks the scope and the scopes above it: `changed_at` moves (the bulk route's ETag), and `due_at` is set a
 * few seconds ahead, pushed back by later changes but never past `dirty_since` plus a minute, so an import recomputes a
 * scope now and then rather than on every paper.
 */
export const scopeState = pgTable(
  'scope_state',
  {
    scopePageId: uuid('scope_page_id')
      .primaryKey()
      .references(() => pages.id, { onDelete: 'cascade' }),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' }).notNull(),
    dirtySince: timestamp('dirty_since', { withTimezone: true, mode: 'date' }),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('scope_state_due_idx').on(t.dueAt)],
);

/**
 * Papers that might belong in a topic (`handoffs/pages.md` Phase 5): machines only suggest, a person confirms. Kept by
 * the `topic-suggestions` consumer (`server/topic-suggestions.ts`) from OpenReview keywords and from the topic's name
 * and aliases in titles and abstracts. Confirming one links the paper (`in-topic`); **a dismissal is remembered**: a
 * row that isn't `open` is never rewritten, so the suggestion doesn't come back.
 */
export const TOPIC_SUGGESTION_STATUSES = ['open', 'dismissed', 'confirmed'] as const;
export const TOPIC_SUGGESTION_REASONS = ['keyword', 'title', 'abstract'] as const;

export const topicSuggestions = pgTable(
  'topic_suggestions',
  {
    topicPageId: uuid('topic_page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    status: text('status', { enum: TOPIC_SUGGESTION_STATUSES }).notNull().default('open'),
    /** The strongest reason: one of its keywords is the topic's name, the name is in its title, or in its abstract. */
    reason: text('reason', { enum: TOPIC_SUGGESTION_REASONS }).notNull(),
    /** The name or alias that matched. */
    matched: text('matched').notNull(),
    score: doublePrecision('score').notNull(),
    decidedBy: uuid('decided_by').references(() => accounts.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.topicPageId, t.paperId] }),
    index('topic_suggestions_open_idx').on(t.topicPageId, t.status, t.score),
    index('topic_suggestions_paper_idx').on(t.paperId),
    check(
      'topic_suggestions_status_check',
      sql.raw(`status in (${TOPIC_SUGGESTION_STATUSES.map((s) => `'${s}'`).join(', ')})`),
    ),
    check(
      'topic_suggestions_reason_check',
      sql.raw(`reason in (${TOPIC_SUGGESTION_REASONS.map((s) => `'${s}'`).join(', ')})`),
    ),
  ],
);

/**
 * Page protection (DESIGN.md §7): who may still edit a page that is being fought over. `established`: accounts
 * verified for a while (`server/page-protection.ts`); `admins`: admins only. Owners (a paper's confirmed authors, a
 * venue's organisers, an org's members, a person), bots through their grants and the system are not held by it.
 * Admins set it (`npm run pages:protect`, `PUT /api/v1/pages/{identifier}/protection`).
 */
export const PROTECTION_LEVELS = ['established', 'admins'] as const;

export const pageProtection = pgTable(
  'page_protection',
  {
    pageId: uuid('page_id')
      .primaryKey()
      .references(() => pages.id, { onDelete: 'cascade' }),
    level: text('level', { enum: PROTECTION_LEVELS }).notNull(),
    reason: text('reason'),
    setBy: uuid('set_by').references(() => accounts.id, { onDelete: 'set null' }),
    setAt: timestamp('set_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** When it lapses by itself; `null`: until an admin lifts it. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  },
  () => [
    check('page_protection_level_check', sql.raw(`level in (${PROTECTION_LEVELS.map((s) => `'${s}'`).join(', ')})`)),
  ],
);

/**
 * Signals (`handoffs/signals.md`): values an app computes about papers, in sets. A set is a plugin's
 * `contributes.signals`, registered by the account its manifest names as `publisher`, who alone writes its values.
 * Values are kept per **generation**: the publisher writes a whole new one beside the live one and then publishes it,
 * so a rebuilt map never shows half its old layout; `live_generation` is what readers see, `staged_generation` the
 * one being written. Not page content, and not in git: the publisher can always push them again.
 */
export const signalSets = pgTable('signal_sets', {
  /** The plugin id, `<owner>/<name>`. */
  id: text('id').primaryKey(),
  /** `github:<owner>/<repo>[/<path>]`. */
  source: text('source').notNull(),
  commit: text('commit').notNull(),
  publisherId: uuid('publisher_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  liveGeneration: integer('live_generation').notNull().default(1),
  stagedGeneration: integer('staged_generation'),
  /** When the live generation last changed: the ETag of every read of the set. */
  changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`clock_timestamp()`),
  createdAt: createdAt(),
});

export const SIGNAL_KINDS = ['vector', 'number', 'label'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** A set's signals, as its manifest at `signal_sets.commit` declares them. */
export const signals = pgTable(
  'signals',
  {
    setId: text('set_id')
      .notNull()
      .references(() => signalSets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: SIGNAL_KINDS }).notNull(),
    /** The manifest's entry: title, description, and `dims`/`metric`, `min`/`max`/`higher`. */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.setId, t.name] }),
    check('signals_kind_check', sql.raw(`kind in (${SIGNAL_KINDS.map((k) => `'${k}'`).join(', ')})`)),
  ],
);

/** The names of a label signal's values in one generation: a map's regions change with every rebuild. */
export const signalLabels = pgTable(
  'signal_labels',
  {
    setId: text('set_id')
      .notNull()
      .references(() => signalSets.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    signal: text('signal').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
  },
  (t) => [primaryKey({ columns: [t.setId, t.generation, t.signal, t.key] })],
);

/**
 * One paper's value of one signal, keyed by the paper's identifier as the publisher gave it (`openreview:abc`) and
 * matched to papers when read, so a value can arrive before its paper does. Exactly one of `num`, `label`, `vec`.
 */
export const signalValues = pgTable(
  'signal_values',
  {
    setId: text('set_id')
      .notNull()
      .references(() => signalSets.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    signal: text('signal').notNull(),
    scheme: text('scheme').notNull(),
    value: text('value').notNull(),
    num: real('num'),
    label: text('label'),
    vec: real('vec').array(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.setId, t.generation, t.signal, t.scheme, t.value] }),
    index('signal_values_paper_idx').on(t.scheme, t.value),
  ],
);

/**
 * Messages at the top of the home page (`components/Announcements.tsx`). Admins write them by script
 * (`npm run announcements`), as there is no admin UI (DESIGN.md §5). Markdown, rendered as a comment is.
 */
export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    body: text('body').notNull(),
    /** Shown only to a signed-in reader. */
    signedInOnly: boolean('signed_in_only').notNull().default(false),
    /** Hidden from then on; never when null. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [index('announcements_created_idx').on(t.createdAt)],
);

export type Announcement = typeof announcements.$inferSelect;

/**
 * Each page's link-preview image, as last drawn (`server/preview-cache.ts`): drawn once per `version`, a hash of what
 * the image shows, so a crawler going through every page draws each at most once. One row per page; a new version
 * replaces it.
 */
export const previewImages = pgTable('preview_images', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),
  png: bytea('png').notNull(),
  drawnAt: timestamp('drawn_at', { withTimezone: true }).notNull().defaultNow(),
});
