import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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
