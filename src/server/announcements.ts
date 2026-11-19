import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { announcements, type Announcement } from '@/db/schema';

/**
 * Messages at the top of the home page, which admins write by script (`npm run announcements`). Their only writer.
 */

export interface AnnouncementInput {
  /** Markdown, rendered as a comment is. */
  body: string;
  /** Shown only to a signed-in reader. */
  signedInOnly?: boolean;
}

export async function addAnnouncement(input: AnnouncementInput, database: Database = getDb()): Promise<Announcement> {
  const body = input.body.trim();
  if (!body) throw new Error('an announcement needs a body');
  const [row] = await database
    .insert(announcements)
    .values({ body, signedInOnly: input.signedInOnly ?? false })
    .returning();
  return row;
}

/** Hides one from now on. False when there was no shown one with that id. */
export async function hideAnnouncement(id: string, database: Database = getDb()): Promise<boolean> {
  const hidden = await database
    .update(announcements)
    .set({ hiddenAt: sql`now()` })
    .where(and(eq(announcements.id, id), isNull(announcements.hiddenAt)))
    .returning({ id: announcements.id });
  return hidden.length > 0;
}

/** What is shown now, newest first; those for signed-in readers only when `signedIn`. */
export async function currentAnnouncements(signedIn: boolean, database: Database = getDb()): Promise<Announcement[]> {
  return database
    .select()
    .from(announcements)
    .where(and(isNull(announcements.hiddenAt), signedIn ? undefined : eq(announcements.signedInOnly, false)))
    .orderBy(desc(announcements.createdAt), desc(announcements.id));
}

/** Every one, hidden too, newest first: what the script lists. */
export async function allAnnouncements(database: Database = getDb()): Promise<Announcement[]> {
  return database.select().from(announcements).orderBy(desc(announcements.createdAt), desc(announcements.id));
}
