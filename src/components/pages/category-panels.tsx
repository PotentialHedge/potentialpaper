import type { ReactNode } from 'react';
import { ui } from '@/components/ui';
import { formatIdentifier, KINDS, pagePath } from '@/lib/kinds';
import type { PageLink } from '@/server/page-links';
import { protectionWords } from '@/server/page-protection';
import type { CategoryOverview } from '@/server/category-pages';
import type { KindPanelProps } from './slots';

/**
 * A category's own panels (`handoffs/pages.md` Phase 5), beside the generic ones in `slots.tsx`. A category works as a
 * Wikipedia category does: the community's article, then the lists made from what is in it, its subcategories and its
 * other pages, by name. What they show comes from `server/category-pages.ts`'s `categoryOverview`, read once by the route
 * (`page-route.tsx`); like every panel, they are the same HTML for every reader.
 */

export type CategoryView = CategoryOverview;

/** What was merged into it, and whether it is protected. */
export function CategoryAbout({ category }: KindPanelProps) {
  if (!category) return null;
  const { protection, mergedFrom } = category;
  const facts: ReactNode[] = [];
  if (mergedFrom.length > 0) {
    facts.push(<>Merged with {mergedFrom.map((key) => formatIdentifier({ kind: 'category', key })).join(', ')}</>);
  }
  facts.push(<a href="/new/category">New category</a>);
  return (
    <div>
      <p className={`${ui.fine} text-center`}>
        {facts.map((fact, i) => (
          <span key={i}>
            {i > 0 && ' · '}
            {fact}
          </span>
        ))}
      </p>
      {protection && (
        <p className={`${ui.fine} text-center`}>
          Protected: {protectionWords(protection.level)}
          {protection.reason ? ` (${protection.reason})` : ''}.
        </p>
      )}
    </div>
  );
}

/** Most of a list shown; the API has the rest (`GET /pages/{identifier}/category`). */
const SHOWN = 200;

function MemberList({ title, links, search }: { title: string; links: PageLink[]; search?: string }) {
  if (links.length === 0) return null;
  return (
    <section>
      <h2 className={ui.groupHeading}>
        {title} <span className={ui.fine}>({links.length.toLocaleString('en')})</span>
        {search && (
          <>
            {' '}
            <a href={search} className={`${ui.fine} font-sans`}>
              search them
            </a>
          </>
        )}
      </h2>
      <ul className="columns-2 gap-8 narrow:columns-1">
        {links.slice(0, SHOWN).map((link) => (
          <li key={link.page.pageId} className="mb-1 break-inside-avoid">
            {link.page.address ? (
              <a href={pagePath(link.page.address)}>{link.page.name ?? formatIdentifier(link.page.address)}</a>
            ) : (
              link.page.name
            )}
            {link.page.kind !== 'paper' && link.page.kind !== 'category' && link.page.kind !== 'web' && (
              <span className={ui.fine}> {KINDS[link.page.kind].title.toLowerCase()}</span>
            )}
          </li>
        ))}
      </ul>
      {links.length > SHOWN && <p className={ui.fine}>and {(links.length - SHOWN).toLocaleString('en')} more</p>}
    </section>
  );
}

/**
 * What is in it, as a Wikipedia category lists it: its subcategories, then its other pages, each by name, with a link
 * to search its papers (the home page, `category:"<name>"` filled in).
 */
export function CategoryMembers({ category, name }: KindPanelProps) {
  if (!category) return null;
  if (category.subcategories.length + category.pages.length === 0) {
    return <p className={ui.empty}>Nothing is in this category yet. Add a page to it from that page.</p>;
  }
  return (
    <>
      <MemberList title="Subcategories" links={category.subcategories} />
      <MemberList
        title="Pages"
        links={category.pages}
        search={
          category.pages.some((link) => link.page.kind === 'paper')
            ? `/?${new URLSearchParams({ q: `category:"${name.replaceAll('"', '')}"` })}`
            : undefined
        }
      />
    </>
  );
}
