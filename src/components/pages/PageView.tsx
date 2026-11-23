import type { ReactNode } from 'react';
import { ArrangedPanels } from '@/components/ArrangedPanels';
import { ArrangedTabs } from '@/components/ArrangedTabs';
import { type PluginPageData, PluginPageProvider } from '@/components/plugins/PluginPage';
import { ui } from '@/components/ui';
import { type GenericSlot, KINDS, type PageKind } from '@/lib/kinds';
import { ReviewBlur } from '@/components/paper/ReviewBlur';
import type { ReviewVenue } from '@/server/under-review';
import type { BuiltPanel } from './common';

function Blurred({ venues, children }: { venues: ReviewVenue[]; children: ReactNode }) {
  return venues.length > 0 ? <ReviewBlur venues={venues}>{children}</ReviewBlur> : children;
}

/**
 * Every kind of page, laid out the same way (`lib/kinds.ts`): its header and the actions under it, then the page
 * itself, `<kind>.main` round `<kind>.aside` (floating) with `<kind>.body` below both, as the first tab, and `<kind>.tabs`
 * panels as tabs beside it. A kind brings only its header and its panels (`paper-route.tsx`, `page-route.tsx`).
 * Rendered once and cached, so the same for every reader: which panels show, and in what order, is the reader's
 * settings', decided in the browser (`ArrangedPanels`, `ArrangedTabs`).
 */
export function PageView({
  kind,
  pageId,
  plugins,
  header,
  actions,
  panels,
  after,
  reviewAt = [],
}: {
  kind: PageKind;
  /** For the Analytics tab its owners see (`Analytics.tsx`). */
  pageId: string;
  plugins: PluginPageData;
  header: ReactNode;
  actions: ReactNode;
  panels: Record<GenericSlot, BuiltPanel[]>;
  /** After the page, outside it: a paper's demo frames. */
  after?: ReactNode;
  /** The venues a paper is under review at: all but its title is blurred until the reader shows it (`ReviewBlur`). */
  reviewAt?: ReviewVenue[];
}) {
  const slot = (name: GenericSlot) => `${kind}.${name}`;
  return (
    <main className={ui.page}>
      <Blurred venues={reviewAt}>
        <PluginPageProvider data={plugins}>
          <article>
            {header}
            {actions}
            <ArrangedTabs
              kind={kind}
              slot={slot('tabs')}
              panels={panels.tabs}
              pageId={pageId}
              lead={{
                title: KINDS[kind].title,
                node: (
                  <>
                    {/* The sidebar floats, so what is below it in the main column takes the full width; on a phone
                      it goes under the main column. */}
                    <div className="flow-root narrow:flex narrow:flex-col">
                      <aside
                        className={`${ui.infobox} float-right mb-4 ml-8 w-[340px] narrow:order-last narrow:float-none narrow:mt-8 narrow:ml-0 narrow:w-auto`}
                      >
                        <ArrangedPanels kind={kind} slot={slot('aside')} panels={panels.aside} />
                      </aside>
                      <div>
                        <ArrangedPanels kind={kind} slot={slot('main')} panels={panels.main} />
                      </div>
                    </div>
                    <ArrangedPanels kind={kind} slot={slot('body')} panels={panels.body} />
                  </>
                ),
              }}
            />
          </article>
        </PluginPageProvider>
        {after}
      </Blurred>
    </main>
  );
}

/** A page's title block: a small line saying what it is (not on a paper, whose title says it), its name, then lines. */
export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <>
      {eyebrow && <p className={`${ui.fine} mt-6 text-center font-sans`}>{eyebrow}</p>}
      <h1 className={`${eyebrow ? 'mt-2' : 'mt-6'} text-center text-[26px] leading-tight font-normal`}>{title}</h1>
      {children}
    </>
  );
}
