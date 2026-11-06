import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FilterIcon, MoreIcon } from '@/components/icons';
import { Pager } from '@/components/Pager';
import { PaperRow } from '@/components/paper/PaperRow';
import { SearchSyntax } from '@/components/paper/SearchSyntax';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { SearchInput } from '@/components/SearchInput';
import { ui } from '@/components/ui';
import { paperIdFromText, paperPath, sourceLinks } from '@/lib/paper-ids';
import { parseSearch } from '@/lib/query';
import { normalizeSearch, SEARCH_MAX_LENGTH, SEARCH_SORTS, type SearchSort } from '@/lib/search';
import { SEARCH_PAGE_SIZE, searchPapers, topVenues, type SearchHit } from '@/server/search';

export const dynamic = 'force-dynamic';

const ON = ui.on;

/** Sorts kept out of the row, in the ⋯ menu (on a phone every sort is in the filter menu). */
const MENU_SORTS: readonly SearchSort[] = ['oldest', 'title'];

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = normalizeSearch(one(sp.q));

  // An identifier goes straight to its page, which fetches the paper if it is new to us.
  const id = q && paperIdFromText(q);
  if (id) redirect(paperPath(id));

  // The search syntax (`lib/query.ts`). A `venue:` in the query says where to look, so the page's own
  // filter steps aside.
  const parsed = q ? parseSearch(q) : null;
  const venue = normalizeSearch(one(sp.venue));
  const venueFilter = parsed?.fields.has('venue') ? null : venue;
  const showAbstracts = one(sp.abstracts) === '1';

  // A search sorts by relevance unless another sort is asked for; relevance needs a search.
  const defaultSort: SearchSort = q ? 'relevance' : 'activity';
  const sorts = SEARCH_SORTS.filter((s) => q || s !== 'relevance');
  const sort = sorts.find((s) => s === one(sp.sort)) ?? defaultSort;

  const filter = { q, venue: venueFilter, sort };
  const requested = Math.max(1, Number.parseInt(one(sp.page) ?? '1', 10) || 1);
  let [{ hits, total }, venues] = await Promise.all([searchPapers({ ...filter, page: requested }), topVenues()]);
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  // Past the end serves the last page, so a stale link after the list shrank still shows something.
  const page = Math.min(requested, pages);
  if (page < requested) ({ hits, total } = await searchPapers({ ...filter, page }));
  if (venue && !venues.includes(venue)) venues = [...venues, venue];

  // Filter links keep the search; `q: ''` drops it (and its relevance sort). They go back to page 1:
  // pages are kept only by the pager's own links.
  const href = (patch: Record<string, string>) => {
    const params = new URLSearchParams({
      ...(q ? { q } : {}),
      ...(venue ? { venue } : {}),
      sort,
      ...(showAbstracts ? { abstracts: '1' } : {}),
      ...patch,
    });
    for (const key of ['q', 'venue', 'abstracts']) if (!params.get(key)) params.delete(key);
    // The default sort stays out of the address, and relevance is gone with the search.
    const chosen = params.get('sort');
    if (chosen === 'relevance' || (chosen === 'activity' && !params.has('q'))) params.delete('sort');
    if (params.get('page') === '1') params.delete('page');
    const query = params.toString();
    return query ? `/?${query}` : '/';
  };

  // Shown on the ⋯ trigger when not the defaults, since the row doesn't show them.
  const moreLabel = [MENU_SORTS.includes(sort) && sort, venue, showAbstracts && 'abstracts'].filter(Boolean).join(', ');
  const toggleAbstracts = href({ abstracts: showAbstracts ? '' : '1' });

  return (
    <main className={ui.page}>
      <header className="mt-12 pb-6 text-center narrow:mt-8">
        <h1 className="mt-2 mb-3 text-[30px] leading-snug font-normal narrow:text-2xl">
          A public page for every paper
        </h1>
        {!q && (
          <div className="mx-auto mt-5 max-w-[min(680px,85%)] text-[14px] leading-[1.55]">
            <h2 className={`${ui.boxHeading} text-center`}>Abstract</h2>
            <p className="text-justify hyphens-auto">
              PotentialPaper gives each research paper one page that verified researchers can edit. Its authors keep a
              section of their own, the community keeps another, and labeled links say how papers connect: which ones
              extend, replicate or contradict each other. Every change is kept as a git commit. Any arXiv link works
              here too: change the domain of <span className={ui.mono}>arxiv.org/abs/1706.03762</span> to this
              site&apos;s. Paper pages can be read, but not yet edited. You can already{' '}
              <Link href="/welcome" className="text-accent">
                join with your institutional email
              </Link>{' '}
              or{' '}
              <Link href="/institutions/request" className="text-accent">
                request your institution
              </Link>
              .
            </p>
          </div>
        )}
      </header>

      {/* A plain GET form, so search works without JavaScript. */}
      <form action="/" method="get" role="search" className="mt-5 flex gap-2">
        {venue && <input type="hidden" name="venue" value={venue} />}
        {showAbstracts && <input type="hidden" name="abstracts" value="1" />}
        <SearchInput
          name="q"
          defaultValue={q ?? ''}
          maxLength={SEARCH_MAX_LENGTH}
          aria-label="Search papers"
          placeholder="Title, arXiv id or DOI"
          className={ui.searchInput}
        />
        <button type="submit" className={ui.searchBtn}>
          Search
        </button>
        <Popover>
          <PopoverTrigger
            type="button"
            title="Search syntax"
            aria-label="Search syntax"
            className="cursor-pointer px-1 font-sans text-sm text-muted hover:text-accent narrow:hidden"
          >
            ?
          </PopoverTrigger>
          <PopoverContent align="end" className="text-xs leading-normal text-muted">
            <SearchSyntax />
          </PopoverContent>
        </Popover>
        {/* On a phone the filters fold into this one menu, with the search syntax. */}
        <Popover>
          <PopoverTrigger
            type="button"
            title="Filters and search syntax"
            aria-label="Filters and search syntax"
            className="relative hidden cursor-pointer px-2.5 text-muted hover:text-accent narrow:flex narrow:items-center"
          >
            <FilterIcon className="size-5" />
            {(venue || showAbstracts) && (
              <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent" />
            )}
          </PopoverTrigger>
          <PopoverContent align="end" className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto text-[13px]">
            <div>
              <h3 className={ui.boxHeading}>Sort</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {sorts.map((s) => (
                  <PopoverClose key={s} asChild>
                    <Link href={href({ sort: s })} className={s === sort ? ON : ''}>
                      {s}
                    </Link>
                  </PopoverClose>
                ))}
              </div>
            </div>
            <div>
              <h3 className={ui.boxHeading}>Venue</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <PopoverClose asChild>
                  <Link href={href({ venue: '' })} className={venue ? '' : ON}>
                    all venues
                  </Link>
                </PopoverClose>
                {venues.map((v) => (
                  <PopoverClose key={v} asChild>
                    <Link href={href({ venue: v })} className={v === venue ? ON : ''}>
                      {v}
                    </Link>
                  </PopoverClose>
                ))}
              </div>
            </div>
            <PopoverClose asChild>
              <Link href={toggleAbstracts} className={showAbstracts ? ON : ''}>
                show abstracts
              </Link>
            </PopoverClose>
            <details className="border-t border-rule pt-2.5">
              <summary className={`${ui.runIn} cursor-pointer`}>Search syntax</summary>
              <div className="mt-2 text-xs leading-normal text-muted">
                <SearchSyntax />
              </div>
            </details>
          </PopoverContent>
        </Popover>
      </form>

      {parsed && parsed.errors.length > 0 && (
        <div className="mt-2 font-sans text-[13px] text-down">Ignored: {parsed.errors.join('; ')}</div>
      )}

      {q && (
        <div className="mt-2 font-sans text-[13px] text-muted">
          {total.toLocaleString('en')} {total === 1 ? 'result' : 'results'} for “{q}”
          {venueFilter && <> in {venueFilter}</>}. <Link href={href({ q: '' })}>clear</Link>
        </div>
      )}

      <div className="mt-2 mb-1 flex flex-wrap items-baseline gap-x-4.5 gap-y-1.5 font-sans text-[13px] text-muted narrow:hidden">
        <span className="flex-1" />
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          sort:
          {sorts
            .filter((s) => !MENU_SORTS.includes(s))
            .map((s) => (
              <Link key={s} href={href({ sort: s })} className={s === sort ? ON : ''}>
                {s}
              </Link>
            ))}
        </span>
        {/* The rarer sorts and the filters, out of the way. */}
        <Popover>
          {/* Not a flex box: an icon alone gives a flex item no text baseline, and the row aligns on
              baselines. Inline, `align-middle` centres the dots on the text's x-height. */}
          <PopoverTrigger
            title="More sorts and filters: venue, abstracts"
            className="-my-1 cursor-pointer px-1 py-1 text-ink hover:text-accent"
          >
            {moreLabel}
            <MoreIcon className={`inline-block size-5 align-middle ${moreLabel ? 'ml-1' : ''}`} />
          </PopoverTrigger>
          <PopoverContent menu align="end" className="text-[13px]">
            {MENU_SORTS.map((s) => (
              <PopoverClose key={s} asChild>
                <Link href={href({ sort: s })} className={s === sort ? ON : ''}>
                  sort: {s}
                </Link>
              </PopoverClose>
            ))}
            <PopoverClose asChild>
              <Link href={href({ venue: '' })} className={`mt-1 border-t border-rule pt-1.5 ${venue ? '' : ON}`}>
                all venues
              </Link>
            </PopoverClose>
            {venues.map((v) => (
              <PopoverClose key={v} asChild>
                <Link href={href({ venue: v })} className={v === venue ? ON : ''}>
                  {v}
                </Link>
              </PopoverClose>
            ))}
            <PopoverClose asChild>
              <Link href={toggleAbstracts} className={`mt-1 border-t border-rule pt-1.5 ${showAbstracts ? ON : ''}`}>
                show abstracts
              </Link>
            </PopoverClose>
          </PopoverContent>
        </Popover>
      </div>

      {total === 0 && (
        <div className={ui.empty}>
          {q ? `No papers match “${q}”. An arXiv id or DOI also finds papers new to us.` : 'No papers here yet.'}
        </div>
      )}

      {total > 0 && (
        <section>
          <div className="h-3.5" />
          {hits.map((hit) => (
            <Row key={`${hit.scheme}:${hit.value}`} hit={hit} abstracts={showAbstracts} />
          ))}
          <Pager page={page} pages={pages} href={(p) => href({ page: String(p) })} />
        </section>
      )}
    </main>
  );
}

function Row({ hit, abstracts }: { hit: SearchHit; abstracts: boolean }) {
  return (
    <PaperRow
      title={hit.title}
      authors={hit.authors}
      abstract={abstracts ? hit.abstract : null}
      venue={hit.venue}
      year={hit.year}
      pdf={hit.pdf ?? sourceLinks(hit).find((link) => link.label === 'PDF')?.url ?? null}
      href={paperPath(hit)}
    />
  );
}
