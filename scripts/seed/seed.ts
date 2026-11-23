import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hashPassword } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool, getDb, getPool } from '@/db';
import { account, user } from '@/db/auth-schema';
import type { Account } from '@/db/schema';
import { normalizeTitle } from '@/lib/versions';
import { ensureAccountForUser, updateProfile } from '@/server/accounts';
import { postComment } from '@/server/comments';
import { CONSUMERS, WORKER_TASKS } from '@/server/consumers';
import { runConsumer } from '@/server/consumers/run';
import { IMPORT_RATE_LIMIT, importReviews } from '@/server/import-reviews';
import { importSubmissions } from '@/server/import-submissions';
import { mergePapers } from '@/server/merge-papers';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/pages/check';
import { findPage } from '@/server/pages/kinds';
import { createCategory, linkPageToCategory } from '@/server/category-pages';
import { syncVenuePages } from '@/server/venue-pages';
import { FIXTURE_PATH, type Fixture } from './fixture';

const forumUrl = (forum: string) => `https://openreview.net/forum?id=${forum}`;

/**
 * `npm run db:seed`: wipes the database in DATABASE_URL, migrates it, and fills it with a small dev data set through
 * the app's own import and commit paths, so every projection (search, submissions, venue pages, stats) is as the
 * worker would leave it. Papers come from fixture.json (built by `potentialpaper-tools`' `seed:*` commands); people, comments and
 * categories are below: extend them here.
 */

/** Every seeded person signs in with this password. */
const PASSWORD = 'papertrail-dev';

/** Institutional addresses, so the accounts are verified and may edit. The first is the one to sign in as. */
const PEOPLE = [
  { email: 'dev@ethz.ch', handle: 'dev', realName: 'Dev User' },
  { email: 'ada@cam.ac.uk', handle: 'ada', realName: 'Ada Lovelace' },
  { email: 'alan@mit.edu', handle: 'alan', realName: 'Alan Turing' },
];

/** Categories, each with the keywords that put a fixture paper in it. */
const CATEGORIES = [
  {
    name: 'Large language models',
    slug: 'llms',
    summary: 'Language models with billions of parameters, trained on web-scale text.',
    match: /language model|llm/i,
  },
  {
    name: 'Diffusion models',
    slug: 'diffusion',
    summary: 'Generative models that learn to reverse a gradual noising process.',
    match: /diffusion/i,
  },
  {
    name: 'Reinforcement learning',
    slug: 'rl',
    summary: 'Learning to act from rewards.',
    match: /reinforcement/i,
  },
];

/** Comments on the first few papers: [who, body, reply to the comment before?]. */
const THREAD: [handle: string, body: string, reply?: boolean][] = [
  ['ada', 'Is the code for the main experiments available anywhere?'],
  ['alan', 'The appendix links a repository, though it is still empty.', true],
  ['dev', 'Table 2 compares against a baseline trained for half as long. Worth keeping in mind.'],
];

function checkLocal(url: string) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && !process.argv.includes('--force')) {
    throw new Error(`refusing to wipe ${host}: db:seed only resets a local database (--force to override)`);
  }
}

async function reset(url: string) {
  // Its own pool: migrations outlast the app's 15 s statement timeout.
  const pool = createPool(url, 10 * 60_000);
  await pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public');
  await migrate(createDb(pool), { migrationsFolder: 'drizzle' });
  await pool.end();
}

async function person(p: (typeof PEOPLE)[number]): Promise<Account> {
  const db = getDb();
  const id = randomUUID();
  await db.insert(user).values({ id, name: p.realName, email: p.email, emailVerified: true });
  await db.insert(account).values({
    id: randomUUID(),
    accountId: id,
    providerId: 'credential',
    userId: id,
    password: await hashPassword(PASSWORD),
    updatedAt: new Date(),
  });
  const created = await ensureAccountForUser({ id, email: p.email });
  return updateProfile(created, { handle: p.handle, realName: p.realName, showInstitution: true });
}

async function papers(fixture: Fixture) {
  for (const venue of fixture.venues) {
    const name = venue.anonymous ? `${venue.name} (under review)` : venue.name;
    const added = await importSubmissions(
      venue.papers.map((p) => ({
        id: p.id,
        title: p.title,
        abstract: p.abstract,
        ...(venue.anonymous
          ? {}
          : { authors: p.authors, venue: p.status === 'accepted' ? venue.name : `${venue.name} submission` }),
      })),
      { name, year: venue.year },
    );
    const reviews = await importReviews(
      {
        source: 'openreview',
        id: venue.group,
        name: venue.name,
        url: venue.url,
        forms: venue.forms,
        license: venue.license,
      },
      venue.papers.map((p) => ({
        externalId: p.id,
        paper: { scheme: 'openreview', value: p.id },
        number: p.number,
        status: p.status,
        decision: p.decision,
        site: p.site,
        keywords: p.keywords,
        primaryArea: p.primaryArea,
        tldr: p.tldr,
        submittedAt: p.submittedAt ? new Date(p.submittedAt) : null,
        url: forumUrl(p.id),
        notes: p.notes.map((n) => ({
          ...n,
          createdAt: new Date(n.createdAt),
          modifiedAt: n.modifiedAt ? new Date(n.modifiedAt) : null,
        })),
      })),
      { rateLimit: IMPORT_RATE_LIMIT, concurrency: 4 },
    );
    for (const f of reviews.failed) console.warn(`  ${f.externalId}: ${f.error}`);
    console.log(`${venue.name}: ${added} papers, ${reviews.notes} notes`);
  }
}

/**
 * A paper submitted to two of the fixture's venues (export-acceptodds picks some) is one paper, as
 * papers:merge leaves it: the earlier venue's is merged into the later one's, keeping both as versions. As an
 * admin, as on the site: the system may not move the imported reviews.
 */
/** `fn`, again after the wait an edit rate limit asks for: the seed edits as people, who are limited. */
async function unhurried<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'rate_limited') throw err;
      const wait = Number((err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 1);
      await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
    }
  }
}

async function merges(fixture: Fixture, actor: Actor) {
  const seen = new Map<string, { id: string; venue: string }>();
  for (const venue of fixture.venues) {
    for (const p of venue.papers) {
      const key = normalizeTitle(p.title);
      const before = seen.get(key);
      seen.set(key, { id: p.id, venue: venue.name });
      if (!before) continue;
      const [duplicate, survivor] = await Promise.all([
        findPage(`openreview:${before.id}`),
        findPage(`openreview:${p.id}`),
      ]);
      if (!duplicate || !survivor) continue;
      await unhurried(() =>
        mergePapers(
          {
            duplicateId: duplicate.id,
            survivorId: survivor.id,
            from: `openreview:${before.id} (${before.venue})`,
            evidence: [forumUrl(before.id), forumUrl(p.id)],
          },
          actor,
        ),
      );
      console.log(`merged ${before.venue} into ${venue.name}: ${p.title}`);
    }
  }
}

async function categories(fixture: Fixture, actor: Actor) {
  const all = fixture.venues.flatMap((v) => v.papers);
  for (const category of CATEGORIES) {
    await createCategory({ name: category.name, slug: category.slug, summary: category.summary }, actor);
    const members = all.filter((p) => p.keywords.some((k) => category.match.test(k))).slice(0, 6);
    for (const p of members) {
      const page = await findPage(`openreview:${p.id}`);
      if (page) await unhurried(() => linkPageToCategory(page, { category: `category:${category.slug}` }, actor));
    }
  }
}

async function comments(fixture: Fixture, people: Map<string, Account>) {
  for (const p of fixture.venues.flatMap((v) => v.papers).slice(0, 3)) {
    const page = await findPage(`openreview:${p.id}`);
    if (!page) continue;
    // A paper page's id is its paper's.
    let previous: string | null = null;
    for (const [handle, body, reply] of THREAD) {
      const posted = await postComment({
        paperId: page.id,
        account: people.get(handle)!,
        body,
        parentId: reply ? previous : null,
      });
      previous = posted.id;
    }
  }
}

/** What the worker would do in the background, until there is nothing left. */
async function project() {
  for (const consumer of CONSUMERS) {
    const report = await runConsumer(consumer, { retryNow: true });
    if (report.status !== 'caught-up')
      console.warn(`  consumer ${consumer.name}: ${report.status} ${report.error ?? ''}`);
  }
  for (const task of WORKER_TASKS) await task.run(getDb());
  await getDb().execute(sql`update scope_state set due_at = clock_timestamp() where due_at is not null`);
  for (const task of WORKER_TASKS) await task.run(getDb());
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  checkLocal(url);
  const started = Date.now();
  await reset(url);
  console.log('database reset and migrated');

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  const people = new Map<string, Account>();
  for (const p of PEOPLE) people.set(p.handle, await person(p));
  await papers(fixture);
  // The venue pages come from the `venues` table, which the reviews consumer fills.
  await project();
  await syncVenuePages();
  const dev = people.get('dev')!;
  await merges(fixture, { kind: 'account', accountId: dev.id, isAdmin: true });
  await categories(fixture, { kind: 'account', accountId: dev.id, isAdmin: false });
  await comments(fixture, people);
  await project();

  console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`sign in as ${PEOPLE.map((p) => p.email).join(', ')} with the password "${PASSWORD}"`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
