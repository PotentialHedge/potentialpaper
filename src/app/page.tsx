import { cookies, headers } from 'next/headers';
import Link from 'next/link';
import { Announcements } from '@/components/Announcements';
import { Collapsible } from '@/components/Collapsible';
import type { TutorialExample } from '@/components/GettingStarted';
import { HomeNextStep } from '@/components/HomeNextStep';
import { InstitutionStrip } from '@/components/InstitutionStrip';
import { redirect } from 'next/navigation';
import { FilterIcon, MoreIcon } from '@/components/icons';
import { Pager } from '@/components/Pager';
import { PaperCard, PaperRow, type RowLink } from '@/components/paper/PaperRow';
import { RowPlugins } from '@/components/plugins/RowPlugins';
import { SearchMatches } from '@/components/paper/SearchMatches';
import { SearchSyntax } from '@/components/paper/SearchSyntax';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { SearchInput } from '@/components/SearchInput';
import { ui } from '@/components/ui';
import { ViewChoice } from '@/components/ViewChoice';
import { HOME_VIEW_COOKIE, homeView, type HomeView } from '@/lib/home-view';
import { DISMISSED_COOKIE, parseDismissed } from '@/lib/announcements';
import { newPaperPath, paperIdFromText, paperPath, shortPath, sourceLinks } from '@/lib/paper-ids';
import { parseSearch } from '@/lib/query';
import { normalizeSearch, SEARCH_MAX_LENGTH, SEARCH_SORTS, type SearchSort } from '@/lib/search';
import { institutionNames } from '@/server/affiliations';
import { currentAnnouncements } from '@/server/announcements';
import { viewerFromHeaders } from '@/server/auth';
import { findPaper, PAPER_SOURCES } from '@/server/papers';
import { canRecommend, recommendationScores } from '@/server/recommendations';
import { siteUrl } from '@/server/site';
import { SEARCH_PAGE_SIZE, searchPapersShared, topVenues, type SearchFilter, type SearchHit } from '@/server/search';

export const dynamic = 'force-dynamic';

const ON = ui.on;

/** The home page's heading. */
const TITLE = 'A wiki page for every paper, written by everyone';

/** Where the site's code is. */
const REPO_URL = 'https://github.com/PotentialHedge/potentialpaper';
/** The project's X profile, the abstract's last line. */
const X_PROFILE_URL = 'https://x.com/uptosomestuff';

/**
 * The home list's sorts: the search's, and `recommended` for a signed-in reader who has done enough for it to mean
 * something (`server/recommendations.ts`), papers near theirs first.
 */
type HomeSort = SearchSort | 'recommended';

/** Sorts kept out of the row, in the ⋯ menu (on a phone every sort is in the filter menu). */
const MENU_SORTS: readonly HomeSort[] = ['oldest', 'title'];

/** The viewer's own papers per page in the "My papers" section; `?mpage=` pages it. */
const MINE_PAGE = 10;
/** The cookie remembering whether that section was left collapsed. */
const MINE_COOKIE = 'home_mine_open';
/** Same for the "Following" section; `?fpage=` pages it. */
const FOLLOWING_PAGE = 10;
const FOLLOWING_COOKIE = 'home_following_open';

/** The getting-started tour's example: the first listed paper with a short title and named authors. */
function tutorialExample(hits: SearchHit[]): TutorialExample | undefined {
  const hit = hits.find((h) => h.authors.length > 0 && !/^anonymous/i.test(h.authors[0]) && h.title.length <= 90);
  return hit && { title: hit.title, authors: hit.authors };
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Page `requested` (1-based) of a list, `size` rows a page. Past the end it serves the last page, so a stale link
 * after the list shrank still shows something.
 */
async function pageOf(
  requested: string | string[] | undefined,
  size: number,
  filter: Omit<SearchFilter, 'page' | 'limit'>,
): Promise<{ hits: SearchHit[]; total: number; page: number; pages: number }> {
  const page = Math.max(1, Number.parseInt(one(requested) ?? '1', 10) || 1);
  const found = await searchPapersShared({ ...filter, page, limit: size });
  const pages = Math.max(1, Math.ceil(found.total / size));
  if (page <= pages) return { ...found, page, pages };
  return { ...(await searchPapersShared({ ...filter, page: pages, limit: size })), page: pages, pages };
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = normalizeSearch(one(sp.q));

  // An identifier goes straight to its page. One new to us is shown first, with papers like it, to be added
  // (`app/new/paper`): it may be another version of one already here.
  const id = q && paperIdFromText(q);
  if (id) redirect(PAPER_SOURCES[id.scheme] && !(await findPaper(id)) ? newPaperPath(id) : paperPath(id));

  // The search syntax (`lib/query.ts`). A `venue:` in the query says where to look, so the page's own
  // filter steps aside.
  const parsed = q ? parseSearch(q) : null;
  const venue = normalizeSearch(one(sp.venue));
  const venueFilter = parsed?.fields.has('venue') ? null : venue;

  const viewer = await viewerFromHeaders(await headers());
  const me = viewer?.account.id ?? null;

  // A search sorts by relevance unless another sort is asked for; relevance needs a search. Browsing, papers are by
  // rating; a reader who can be recommended papers also has `recommended`, after it.
  const recommends = me !== null && !q && (await canRecommend(me));
  const browseDefault: HomeSort = 'rating';
  const defaultSort: HomeSort = q ? 'relevance' : browseDefault;
  const sorts: HomeSort[] = SEARCH_SORTS.filter((s) => q || s !== 'relevance').flatMap((s) =>
    s === 'rating' && recommends ? ['rating', 'recommended'] : [s],
  );
  const sort = sorts.find((s) => s === one(sp.sort)) ?? defaultSort;
  // What the database sorts by: the recommended papers come first by their scores, the rest by activity.
  const recommendScores = sort === 'recommended' && me ? await recommendationScores(me) : null;
  const searchSort: SearchSort = sort === 'recommended' ? 'activity' : sort;
  // ?following=1: only papers the signed-in viewer follows.
  const onlyFollowed = me !== null && one(sp.following) === '1';
  // The viewer's own papers, then the papers they follow, are pinned above the list, as acceptodds pins
  // followed papers and positions: same venue and sort, each paged on its own, and none repeated. A paper both
  // theirs and followed is under My papers. Not while searching, nor when the list is already only followed papers.
  const pins = me !== null && !q && !onlyFollowed;
  const browse = { venue, sort: searchSort };
  const [all, mine, followed, topVenueList, announced, institutions] = await Promise.all([
    pageOf(sp.page, SEARCH_PAGE_SIZE, {
      q,
      venue: venueFilter,
      sort: searchSort,
      followedBy: onlyFollowed ? me : null,
      exceptAuthoredBy: pins ? me : null,
      exceptFollowedBy: pins ? me : null,
      recommendScores,
    }),
    pins ? pageOf(sp.mpage, MINE_PAGE, { ...browse, authoredBy: me }) : null,
    pins ? pageOf(sp.fpage, FOLLOWING_PAGE, { ...browse, followedBy: me, exceptAuthoredBy: me }) : null,
    topVenues(),
    currentAnnouncements(viewer !== null),
    institutionNames(),
  ]);
  const venues = venue && !topVenueList.includes(venue) ? [...topVenueList, venue] : topVenueList;
  const cookieJar = await cookies();
  // Compact rows by default; detailed shows each paper's cover and TL;DR or abstract. The choice is remembered.
  const detailed = homeView(one(sp.view), one(sp.abstracts), cookieJar.get(HOME_VIEW_COOKIE)?.value) === 'detailed';
  const mineOpen = cookieJar.get(MINE_COOKIE)?.value !== '0';
  const followingOpen = cookieJar.get(FOLLOWING_COOKIE)?.value !== '0';
  const dismissed = new Set(parseDismissed(cookieJar.get(DISMISSED_COOKIE)?.value));
  const pinnedCount = (mine?.total ?? 0) + (followed?.total ?? 0);
  // Every paper listed, top to bottom: what plugins that add to rows are told (`RowPlugins`).
  const listed = [...(mine?.hits ?? []), ...(followed?.hits ?? []), ...all.hits].map(hitIdentifier);

  // Filter links keep the search; `q: ''` drops it (and its relevance sort). They go back to page 1:
  // pages are kept only by the pager's own links.
  const href = (patch: Record<string, string>) => {
    const params = new URLSearchParams({
      ...(q ? { q } : {}),
      ...(venue ? { venue } : {}),
      sort,
      ...(onlyFollowed ? { following: '1' } : {}),
      ...patch,
    });
    for (const key of ['q', 'venue', 'view']) if (!params.get(key)) params.delete(key);
    if (params.get('following') === '0') params.delete('following');
    // The default sort stays out of the address, and relevance is gone with the search.
    const chosen = params.get('sort');
    if (chosen === 'relevance' || (chosen === browseDefault && !params.has('q'))) params.delete('sort');
    for (const key of ['page', 'mpage', 'fpage']) if (params.get(key) === '1') params.delete(key);
    const query = params.toString();
    return query ? `/?${query}` : '/';
  };
  // A pager's link to page `p` of its section, keeping the other sections' pages.
  const pages = { page: String(all.page), mpage: String(mine?.page ?? 1), fpage: String(followed?.page ?? 1) };
  const pageHref = (key: keyof typeof pages, anchor: string) => (p: number) =>
    `${href({ ...pages, [key]: String(p) })}${anchor}`;

  // Shown on the ⋯ trigger when not the defaults, since the row doesn't show them.
  const moreLabel = [MENU_SORTS.includes(sort) && sort, venue, onlyFollowed && '★'].filter(Boolean).join(', ');
  const viewLink = (v: HomeView) => (
    <ViewChoice view={v} href={href({})} className={detailed === (v === 'detailed') ? ON : ''} />
  );

  return (
    <main className={ui.page}>
      <Announcements items={announced.filter((a) => !dismissed.has(a.id))} />
      <header className="mt-12 pb-6 text-center narrow:mt-8">
        <h1 className="mt-2 mb-3 text-[30px] leading-snug font-normal narrow:text-2xl">{TITLE}</h1>
        {!q && (
          <div className="mx-auto mt-5 max-w-[min(680px,85%)] text-[14px] leading-[1.55]">
            <HomeNextStep example={tutorialExample(all.hits)} host={new URL(siteUrl()).host} />
            <h2 className={`${ui.boxHeading} text-center`}>Abstract</h2>
            <p className="text-justify hyphens-auto">
              potential<span className="text-accent">paper</span> is a wiki for papers: each one gets a public page,
              with a community section and an author section. Add demos, explainers or how a paper relates to your work.
              Every page is a git repository you can edit on your machine, in the browser or with your agent. Missing a
              feature? Extend the site by asking your agent to add a plugin. To add a paper not yet on the site, paste
              in an arxiv or DOI link and the page will be created. potentialpaper is independent: it is not affiliated
              with or connected to any institution. All code is available at{' '}
              <a href={REPO_URL} className={ui.hyperref} rel="noopener noreferrer">
                {REPO_URL.replace(/^https:\/\//, '')}
              </a>
              .{' '}
              <a href={X_PROFILE_URL} target="_blank" rel="noopener noreferrer" className={ui.hyperref}>
                Follow for updates
              </a>{' '}
              on X.
            </p>
          </div>
        )}
        <InstitutionStrip names={institutions} />
      </header>

      {/* A plain GET form, so search works without JavaScript. */}
      <form action="/" method="get" role="search" className="mt-5 flex gap-2">
        {venue && <input type="hidden" name="venue" value={venue} />}
        {onlyFollowed && <input type="hidden" name="following" value="1" />}
        <SearchInput
          name="q"
          defaultValue={q ?? ''}
          maxLength={SEARCH_MAX_LENGTH}
          aria-label="Search papers"
          placeholder="Search for a paper"
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
            {(venue || onlyFollowed) && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent" />}
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
            {viewer && (
              <PopoverClose asChild>
                <Link href={href({ following: onlyFollowed ? '0' : '1' })} className={onlyFollowed ? ON : ''}>
                  ★ following only
                </Link>
              </PopoverClose>
            )}
            <div>
              <h3 className={ui.boxHeading}>View</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <PopoverClose asChild>{viewLink('compact')}</PopoverClose>
                <PopoverClose asChild>{viewLink('detailed')}</PopoverClose>
              </div>
            </div>
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
          {all.total.toLocaleString('en')} {all.total === 1 ? 'result' : 'results'} for “{q}”
          {venueFilter && <> in {venueFilter}</>}. <Link href={href({ q: '' })}>clear</Link>
        </div>
      )}

      <div className="mt-2 mb-1 flex flex-wrap items-baseline gap-x-4.5 gap-y-1.5 font-sans text-[13px] text-muted narrow:hidden">
        <span className="flex gap-x-3">
          view:
          {viewLink('compact')}
          {viewLink('detailed')}
        </span>
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
            title="More sorts and filters: venue, following"
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
            {viewer && (
              <PopoverClose asChild>
                <Link
                  href={href({ following: onlyFollowed ? '0' : '1' })}
                  className={`mt-1 border-t border-rule pt-1.5 ${onlyFollowed ? ON : ''}`}
                >
                  ★ following
                </Link>
              </PopoverClose>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {all.total + pinnedCount === 0 &&
        (q ? (
          <div className={ui.empty}>
            {onlyFollowed
              ? `No papers you follow match “${q}”.`
              : `No papers match “${q}”. An arXiv id or DOI also finds papers new to us.`}
          </div>
        ) : onlyFollowed ? (
          <div className={ui.empty}>No papers you follow here. Follow one with ☆ on its page.</div>
        ) : (
          <div className={ui.empty}>No papers here yet.</div>
        ))}

      <RowPlugins list="home" papers={listed}>
        {mine && mine.total > 0 && (
          <Collapsible
            id="mine"
            cookie={MINE_COOKIE}
            open={mineOpen}
            className="group"
            summary={
              <>
                My papers <span className="font-normal">({mine.total})</span>
              </>
            }
          >
            {mine.hits.map((hit) => (
              <Row key={`${hit.scheme}:${hit.value}`} hit={hit} detailed={detailed} />
            ))}
            <Pager page={mine.page} pages={mine.pages} href={pageHref('mpage', '#mine')} />
          </Collapsible>
        )}

        {followed && followed.total > 0 && (
          <Collapsible
            id="following"
            cookie={FOLLOWING_COOKIE}
            open={followingOpen}
            className="group"
            summary={
              <>
                Following <span className="font-normal">({followed.total})</span>
              </>
            }
          >
            {followed.hits.map((hit) => (
              <Row key={`${hit.scheme}:${hit.value}`} hit={hit} detailed={detailed} />
            ))}
            <Pager page={followed.page} pages={followed.pages} href={pageHref('fpage', '#following')} />
          </Collapsible>
        )}

        {all.total > 0 && (
          <section id="all">
            {pinnedCount > 0 ? (
              <h2 className={`mt-7 mb-2 ${ui.section}`}>
                {sort === 'recommended' ? 'Recommended for you' : 'All papers'}{' '}
                <span className="font-normal">({all.total.toLocaleString('en')})</span>
              </h2>
            ) : (
              <div className="h-3.5" />
            )}
            {all.hits.map((hit) => (
              <Row key={`${hit.scheme}:${hit.value}`} hit={hit} detailed={detailed} />
            ))}
            <Pager page={all.page} pages={all.pages} href={pageHref('page', pinnedCount > 0 ? '#all' : '')} />
          </section>
        )}
      </RowPlugins>
    </main>
  );
}

/** A hit's page identifier, as plugins name papers: `arxiv:1706.03762`. */
function hitIdentifier(hit: SearchHit): string {
  return `${hit.scheme}:${hit.value}`;
}

/**
 * The link beside a row: the PDF, ours or arXiv's; or, with none, the paper's page at its source, so every row
 * leads somewhere outside.
 */
function rowLink(hit: SearchHit): RowLink | null {
  const pdf = hit.pdf ?? sourceLinks(hit).find((link) => link.label === 'PDF')?.url;
  if (pdf) return { label: 'pdf', url: pdf };
  const [page] = sourceLinks(hit);
  if (!page) return null;
  switch (hit.scheme) {
    case 'arxiv':
      return { label: 'arXiv', url: page.url };
    case 'openreview':
      return { label: 'forum', url: page.url, title: 'On OpenReview' };
    case 'doi':
      return { label: 'doi', url: page.url, title: `doi:${hit.value}` };
  }
}

function Row({ hit, detailed }: { hit: SearchHit; detailed: boolean }) {
  const props = {
    paper: hitIdentifier(hit),
    title: hit.title,
    authors: hit.authors,
    venue: hit.venue,
    // The mean review score beside the venue, when there is one: "ICLR 2027 (5.0 → 5.5)".
    score: hit.venue && hit.rating !== null ? { mean: hit.rating, first: hit.firstRating } : null,
    year: hit.year,
    link: rowLink(hit),
    href: shortPath(hit.shortId),
  };
  return (
    <>
      {detailed ? (
        <PaperCard {...props} abstract={hit.abstract} tldr={hit.tldr} cover={hit.cover} />
      ) : (
        <PaperRow {...props} />
      )}
      <SearchMatches matches={hit.matches} count={hit.matchCount} />
    </>
  );
}
