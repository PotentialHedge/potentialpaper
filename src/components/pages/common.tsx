import { type ComponentType, Fragment, type ReactNode } from 'react';
import { AddMissing } from '@/components/paper/AddMissing';
import { AddCategory } from '@/components/categories/AddCategory';
import { AuthorPanels, CommunityPanels } from '@/components/plugins/NestedPanels';
import { ui } from '@/components/ui';
import {
  formatIdentifier,
  GENERIC_SLOTS,
  type GenericSlot,
  KINDS,
  pagePath,
  type PageAddress,
  type PageKind,
} from '@/lib/kinds';
import { CATEGORY_LABEL } from '@/lib/labeled-links';
import { toolPath } from '@/lib/page-tools';
import { type PanelKind, slotPanels } from '@/lib/panels';
import type { OwnersInfo } from '@/server/owners';
import type { PageLink } from '@/server/page-links';
import { LinksBox } from './LinkLists';

/**
 * What every kind of page has, and the panels that show it the same way on each (`lib/panels.ts`): its sections, as
 * one document, its labeled links and what links here. A kind's own panels take these props and more
 * (`components/paper/slots.tsx`, `./slots.tsx`). Like every panel, the same HTML for every reader.
 */
export interface PageCommon {
  kind: PageKind;
  address: PageAddress;
  pageId: string;
  name: string;
  /** `owners/` and `community/`, as rendered at their last commit. */
  ownersHtml: string | null;
  communityHtml: string | null;
  linksFrom: PageLink[];
  linksTo: PageLink[];
  /** Who owns it (`server/owners.ts`); `null` on a kind without owners. */
  owners: OwnersInfo | null;
}

/** Opens the Edit dialog (`EditDialog`), from anywhere on the page. */
export const EDIT = '#edit';

/** How each kind asks its owners in, while it has none, and once it has some. */
const ASK: Partial<Record<OwnersInfo['claim'], { question: string; action: string; join: string; pitch: string }>> = {
  authors: {
    question: 'Are you an author?',
    action: 'Claim this paper',
    join: 'also an author?',
    pitch: "to see who's reading it, with views and other statistics, and to write about it here.",
  },
  organisers: {
    question: 'Organise this venue?',
    action: 'Claim it',
    join: 'also organising?',
    pitch: "to see who's reading it, with views and other statistics, and to write here.",
  },
  domain: { question: 'A member?', action: 'See how', join: 'how to join', pitch: 'to write here.' },
};

/** The invitation in a community part nobody has started, by kind: its title and what to write. */
const COMMUNITY_INVITE: Partial<Record<PageKind, { title: string; hint: string }>> = {
  paper: {
    title: 'Be the first to write about this paper',
    hint: 'Add a summary, why it matters, a critique, errata or a reproduction.',
  },
  category: {
    title: 'Be the first to write about this topic',
    hint: 'Add what it is, its key ideas, its history or its open problems.',
  },
};
const INVITE = { title: 'Be the first to write here', hint: 'Anything that helps the next reader.' };

function Html({ html }: { html: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A part's small label, with its edit links: "From the authors: Ada Lovelace · edit". */
function PartLabel({ children }: { children: ReactNode }) {
  return <p className={`${ui.fine} mb-2 font-sans`}>{children}</p>;
}

/**
 * The page's sections as one document: the owners' first (`owners/`, which only they write), then the community's
 * (`community/`, anyone verified), each with a small label saying whose they are when the kind has both. While a page
 * has no owners, their part is one line asking them in. A category has only the community's, its article; a person's
 * page only its own.
 */
export function Sections({ kind, address, ownersHtml, communityHtml, owners }: PageCommon) {
  const { community } = KINDS[kind];
  const both = owners !== null && community;
  const ask = owners && ASK[owners.claim];
  const history = toolPath('history', address);
  return (
    <section id="sections" className="mt-5">
      {owners && (
        <div id="owners">
          {ask && !owners.claimed ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-frame bg-card px-4 py-3 font-sans text-[13px]">
              <p className="min-w-0 flex-1 basis-64 text-muted">
                <strong className="text-ink">{ask.question}</strong> {ask.action} {ask.pitch}
              </p>
              <a href={owners.claimPath ?? undefined} rel="nofollow" className={ui.btn({ ghost: true, inline: true, flush: true })}>
                {ask.action}
              </a>
            </div>
          ) : (
            both && (
              <PartLabel>
                From {owners.title}
                {owners.people.length > 0 && ': '}
                {owners.people.map((p, i) => (
                  <Fragment key={p.authorIndex}>
                    {i > 0 && ', '}
                    {p.href ? <a href={p.href}>{p.name}</a> : p.name}
                  </Fragment>
                ))}{' '}
                ·{' '}
                <a href={EDIT} rel="nofollow">
                  edit
                </a>
                {owners.claimPath && ask && (
                  <>
                    {' '}
                    ·{' '}
                    <a href={owners.claimPath} rel="nofollow">
                      {ask.join}
                    </a>
                  </>
                )}
              </PartLabel>
            )
          )}
          {ownersHtml ? (
            <Html html={ownersHtml} />
          ) : (
            both && owners.claimed && <p className={`${ui.fine} font-sans`}>Nothing yet.</p>
          )}
          {/* The plugins' panels a paper's authors let in (`paper.author`, `owners/plugins.json`). */}
          {kind === 'paper' && (
            <div className="flow-root">
              <AuthorPanels />
            </div>
          )}
        </div>
      )}
      {community && (
        <div id="community" className={both ? 'mt-6' : undefined}>
          {both && communityHtml && (
            <PartLabel>
              From the community ·{' '}
              <a href={EDIT} rel="nofollow">
                edit
              </a>{' '}
              · <a href={history}>history</a>
            </PartLabel>
          )}
          {communityHtml ? (
            <Html html={communityHtml} />
          ) : (
            <CommunityInvite kind={kind} />
          )}
          {kind === 'paper' && (
            <div className={`${ui.fine} mt-3 font-sans`}>
              <AddMissing what="demo" paperPath={pagePath(address)} />
            </div>
          )}
          {/* Plugins' panels in the community's sections (`paper.community`): the paper map's minimap. */}
          {kind === 'paper' && (
            <div className="flow-root">
              <CommunityPanels />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A community part nobody has started: an invitation to write the first of it, not an empty room. */
function CommunityInvite({ kind }: { kind: PageKind }) {
  const { title, hint } = COMMUNITY_INVITE[kind] ?? INVITE;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-dashed border-frame px-4 py-3 font-sans text-[13px]">
      <p className="min-w-0 flex-1 basis-64 text-muted">
        <strong className="text-ink">{title}.</strong> {hint}
      </p>
      <a href={EDIT} rel="nofollow" className={ui.btn({ inline: true, flush: true })}>
        Start writing
      </a>
    </div>
  );
}

/** Its labeled links, but for the categories it is in, which the Categories box shows. */
export function Links({ linksFrom }: PageCommon) {
  return <LinksBox links={linksFrom.filter((link) => link.label !== CATEGORY_LABEL)} direction="from" />;
}

/** What links here, but for a category's members, which its own lists show. */
export function Backlinks({ kind, linksTo }: PageCommon) {
  const links = kind === 'category' ? linksTo.filter((link) => link.label !== CATEGORY_LABEL) : linksTo;
  return <LinksBox links={links} direction="to" />;
}

/**
 * The categories it is in, a box in the sidebar, as Wikipedia lists a page's categories: its own `in-category` links,
 * and "Add" (`AddCategory`), which puts it in one by name, making the category if none has that name yet.
 */
export function Categories({ address, linksFrom }: PageCommon) {
  const categories = linksFrom.filter((link) => link.label === CATEGORY_LABEL);
  return (
    <div className={ui.box}>
      <div className={ui.boxHeadingRow}>
        <h2 className={ui.runIn}>Categories</h2>
        <AddCategory identifier={formatIdentifier(address)} label="Add" className={ui.boxAction} />
      </div>
      {categories.length > 0 ? (
        <ul className="space-y-1">
          {categories.map((link, i) => (
            <li key={i}>
              {link.page.address ? (
                <a href={pagePath(link.page.address)} className={link.page.name ? 'text-ink' : 'text-muted italic'}>
                  {link.page.name ?? formatIdentifier(link.page.address)}
                </a>
              ) : (
                link.page.name
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">Not in a category yet.</p>
      )}
    </div>
  );
}

export interface BuiltPanel {
  id: string;
  title: string;
  node: ReactNode;
}

/**
 * A kind's built-in panels, by slot, from its panels by id (`lib/panels.ts` gives each its slot and default order).
 * `present` leaves out a panel that would be empty (a person's tab for an item the account doesn't show).
 */
export function buildPanels<P extends object>(
  kind: PageKind,
  panels: Record<string, ComponentType<P>>,
  props: P,
  present: (id: string) => boolean = () => true,
): Record<GenericSlot, BuiltPanel[]> {
  const out = {} as Record<GenericSlot, BuiltPanel[]>;
  for (const slot of GENERIC_SLOTS) {
    out[slot] = slotPanels(kind as PanelKind, `${kind}.${slot}`)
      .filter(({ id }) => present(id))
      .map(({ id, title }) => {
        const Panel = panels[id];
        return { id, title, node: <Panel {...props} /> };
      });
  }
  return out;
}
