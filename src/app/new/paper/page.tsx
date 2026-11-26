import type { Metadata } from 'next';
import { listedVenue, venueLine } from '@/lib/paper-file';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { paperIdFromText, paperPath, shortPath, type PaperId } from '@/lib/paper-ids';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { describePaper } from '@/server/papers';
import { similarPapers } from '@/server/search';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Add a paper · potentialpaper', robots: { index: false, follow: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function named({ scheme, value }: PaperId): string {
  return scheme === 'arxiv' ? `arXiv:${value}` : `${scheme}:${value}`;
}

function authorLine(names: readonly string[]): string {
  if (names.length === 0) return 'Anonymous authors';
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
}

/**
 * A paper new to us, as a search for its identifier finds it (`app/page.tsx`): what its source says of it, to add
 * its page, and the papers here with titles like it, which it may be another version of. Adding it to one of those
 * (`./version`) merges it in, so its identifier leads there.
 */
export default async function NewPaperPage({ searchParams }: Props) {
  const query = await searchParams;
  const text = one(query.id) ?? '';
  const id = paperIdFromText(text);
  if (!id) notFound();
  const here = `/new/paper?${new URLSearchParams({ id: text })}`;
  const found = await describePaper(id);
  const problem = one(query.problem);
  if (found.status === 'found') {
    if (!problem) redirect(paperPath(id));
    // "Add as a version" added its page but could not merge it (`./version`).
    return (
      <main className={ui.page}>
        <h1 className="mt-6 text-[26px] leading-tight font-normal">{found.paper.title}</h1>
        <p className={ui.note(false)}>It could not be added as a version: {problem}</p>
        <p className="mt-2 font-sans text-sm">
          It has a page of its own now: <a href={paperPath(id)}>open it</a>.
        </p>
      </main>
    );
  }

  if (found.status !== 'described') {
    return (
      <main className={ui.page}>
        <h1 className="mt-6 text-[26px] leading-tight font-normal">{named(id)}</h1>
        <p className={ui.empty}>
          {found.status === 'missing'
            ? `There is no paper ${named(id)}.`
            : `${id.scheme === 'arxiv' ? 'arXiv' : 'Its source'} isn't answering just now. Try again in a minute.`}
        </p>
      </main>
    );
  }

  const { paper } = found;
  const { year } = listedVenue(paper.versions);
  const [similar, viewer] = await Promise.all([similarPapers(paper.title), viewerFromHeaders(await headers())]);
  return (
    <main className={ui.page}>
      <p className={`${ui.fine} mt-6 font-sans`}>{named(id)} isn&apos;t here yet</p>
      <h1 className="mt-1 text-[26px] leading-tight font-normal">{paper.title}</h1>
      <p className="mt-1 font-sans text-sm text-muted">
        {authorLine(paper.authors)}
        {year ? ` · ${year}` : ''}
      </p>
      {paper.abstract && (
        <p className="mt-3 line-clamp-4 max-w-[760px] text-[14px] leading-snug text-subtle">{paper.abstract}</p>
      )}
      <a href={paperPath(id)} className={`${ui.btn({ inline: true, flush: true })} mt-4`}>
        Add its page
      </a>
      {problem && <p className={ui.note(false)}>{problem}</p>}

      {similar.length > 0 && (
        <section className="mt-10 max-w-[760px]">
          <h2 className={ui.sectionHeading}>Or is it a version of one of these?</h2>
          <ul>
            {similar.map((s) => (
              <li
                key={s.shortId}
                className="flex items-baseline gap-4 border-b border-dotted border-rule-strong py-2 narrow:flex-col narrow:gap-1"
              >
                <span className="min-w-0 flex-1 leading-[1.35]">
                  <a href={shortPath(s.shortId)} className="hover:no-underline">
                    {s.title}
                  </a>
                  <span className="block font-sans text-xs text-muted">
                    {[authorLine(s.authors), venueLine(s.venue, s.year)].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {viewer ? (
                  <form action="/new/paper/version" method="post" className="shrink-0">
                    <input type="hidden" name="id" value={`${id.scheme}:${id.value}`} />
                    <input type="hidden" name="into" value={s.shortId} />
                    <button type="submit" className={`${ui.linkBtn} font-sans text-xs`}>
                      Add as a version
                    </button>
                  </form>
                ) : (
                  <a
                    href={authHref('/signin', here)}
                    className="shrink-0 font-sans text-xs"
                    data-umami-event="signin_prompt_clicked"
                    data-umami-event-target="add_version"
                    data-seen-event="signin_prompt_shown"
                    data-seen-target="add_version"
                  >
                    Sign in to add as a version
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
