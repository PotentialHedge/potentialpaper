import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SearchForm } from '@/components/paper/SearchForm';
import { ui } from '@/components/ui';
import { paperIdFromText, paperPath } from '@/lib/paper-ids';
import { searchPapers } from '@/server/search';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Search · PotentialPaper' };

const MAX_PAGE = 500;

export default async function Search({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = typeof params.q === 'string' ? params.q.trim() : '';
  const requested = Number(params.page);
  const page = Number.isInteger(requested) && requested >= 1 && requested <= MAX_PAGE ? requested : 1;

  // An identifier goes straight to its page, which fetches the paper if it is new to us.
  const id = paperIdFromText(query);
  if (id) redirect(paperPath(id));

  const { hits, hasMore } = await searchPapers(query, page);
  const pageHref = (to: number) => `/search?q=${encodeURIComponent(query)}&page=${to}`;
  return (
    <main className={ui.page}>
      <h1 className="mt-6 mb-3 text-[26px] font-normal">Search</h1>
      <SearchForm query={query} />
      {query.length >= 2 && hits.length === 0 && (
        <p className={ui.empty}>
          {page > 1
            ? 'No more results.'
            : 'No papers match. Try an arXiv id or DOI, which also finds papers new to us.'}
        </p>
      )}
      <ol className="mt-4 space-y-5">
        {hits.map((hit) => (
          <li key={`${hit.scheme}:${hit.value}`}>
            <Link href={paperPath(hit)} className="text-[17px]">
              {hit.title}
            </Link>
            <p className={ui.fine}>
              {[hit.authors.join(', ') || 'Anonymous authors', hit.venue, hit.year].filter(Boolean).join(' · ')}
            </p>
            {hit.abstract && <p className="mt-1 line-clamp-3 text-sm text-subtle">{hit.abstract}</p>}
          </li>
        ))}
      </ol>
      {(page > 1 || hasMore) && (
        <nav className="mt-6 flex justify-between font-sans text-sm">
          {page > 1 ? <Link href={pageHref(page - 1)}>Previous</Link> : <span />}
          {hasMore && <Link href={pageHref(page + 1)}>Next</Link>}
        </nav>
      )}
    </main>
  );
}
