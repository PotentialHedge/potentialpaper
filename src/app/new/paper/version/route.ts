import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { pages } from '@/db/schema';
import { paperIdFromText, shortPath } from '@/lib/paper-ids';
import { authHref } from '@/lib/return-to';
import { ApiError } from '@/server/api/errors';
import { authenticate } from '@/server/auth';
import { mergePapers } from '@/server/merge-papers';
import { lookupPaper } from '@/server/papers';
import { refreshPageIds } from '@/server/pages/refresh';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

function to(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${siteUrl()}${path}` } });
}

/**
 * "Add as a version" on the "Add it?" page (`../page.tsx`): adds the new paper's page, as a search for it would, and
 * merges it into the paper chosen, as the signed-in reader, so its versions join that paper's and its identifier leads
 * there. A plain form post, which ends on the paper's page, or back on the form saying what went wrong.
 */
export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const text = String(form.get('id') ?? '');
  const into = String(form.get('into') ?? '');
  const id = paperIdFromText(text);
  const back = (problem?: string) => `/new/paper?${new URLSearchParams({ id: text, ...(problem ? { problem } : {}) })}`;
  if (!id || !/^\d{1,9}$/.test(into)) return to(back('That paper could not be found.'));

  let principal;
  try {
    principal = await authenticate(req);
  } catch (err) {
    if (err instanceof ApiError) return to(back(err.message));
    throw err;
  }
  if (!principal) return to(authHref('/signin', back()));

  const db = getDb();
  const [survivor] = await db
    .select({ id: pages.id, kind: pages.kind })
    .from(pages)
    .where(eq(pages.shortId, Number(into)));
  if (!survivor || survivor.kind !== 'paper') return to(back('That paper could not be found.'));

  const found = await lookupPaper(id);
  if (found.status === 'missing') return to(back(`There is no paper ${text}.`));
  if (found.status === 'unavailable') return to(back("Its source isn't answering just now. Try again in a minute."));
  if (found.paper.id === survivor.id) return to(shortPath(Number(into)));

  try {
    await mergePapers(
      {
        duplicateId: found.paper.id,
        survivorId: survivor.id,
        from: text,
        summary: `Add ${text} as a version of this paper`,
      },
      { kind: 'account', accountId: principal.account.id, isAdmin: principal.isAdmin },
    );
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    // Its page was added; the merge wasn't. The form's page says so.
    return to(back(err.message));
  }
  await refreshPageIds(db, [found.paper.id, survivor.id]);
  return to(shortPath(Number(into)));
}
