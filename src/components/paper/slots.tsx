import type { ComponentType } from 'react';
import { Backlinks, Links, type PageCommon, Sections, Categories } from '@/components/pages/common';
import { pagePath } from '@/lib/kinds';
import { ui } from '@/components/ui';
import type { PanelId } from '@/lib/panels';
import { AbstractText } from '@/components/AbstractText';
import type { Paper } from '@/db/schema';
import { sourceLinks, sourceName, type PaperId } from '@/lib/paper-ids';
import { Comments } from './Comments';
import { PictureDrop } from './PictureDrop';
import type { Submission } from '@/lib/submissions';
import type { PdfPointer } from '@/server/pages/rules';
import { SubmissionsSection } from './Submissions';
import { Facts } from './Facts';
import type { PaperFacts } from '@/lib/paper-facts';
import { VersionsBox, VersionsSection } from './Versions';
import type { PaperVersion } from '@/lib/versions';

/**
 * A paper's own panels (`lib/panels.ts`), beside every kind's (`components/pages/common.tsx`), rendered into its slots
 * by the page every kind shares (`components/pages/PageView.tsx`). Panels render the same HTML for every reader,
 * because the edge caches the page: anything about the viewer belongs in a client island.
 */

export interface PanelProps extends PageCommon {
  paper: Paper;
  identifiers: PaperId[];
  pdf: PdfPointer | null;
  /** The authors' thumbnail, or else the PDF's first page. */
  picture: { url: string; alt: string | null; caption: string } | null;
  /** The PDF's first page, which the picture editor falls back to. */
  cover: string | null;
  submissions: Submission[];
  /** The page's `versions/`, oldest first. */
  versions: PaperVersion[];
  /** The identifier the page's API calls name the paper by. */
  canonical: PaperId;
  /** What the infobox, the JSON-LD and the meta tags say about it (`lib/paper-facts.ts`). */
  facts: PaperFacts;
}

/** Its Markdown and TeX rendered, with "Abstract." run into its first paragraph. */
function Abstract({ paper, facts }: PanelProps) {
  const tldr = facts.tldr && (
    <p className="mb-3">
      <b>TL;DR.</b> {facts.tldr}
    </p>
  );
  if (!paper.abstract) {
    return (
      <>
        {tldr}
        <p>
          <b>Abstract.</b>{' '}
          <span className="text-muted italic">We can&apos;t show this paper&apos;s abstract here.</span>
        </p>
      </>
    );
  }
  return (
    <>
      {tldr}
      <AbstractText text={paper.abstract} area="abstract" />
    </>
  );
}

/** The picture, and the PDF with where our copy came from. The paper's addresses elsewhere are under its title. */
function ReadThePaper({ identifiers, pdf, picture, canonical, address }: PanelProps) {
  const opens = pdf?.url ?? identifiers.flatMap(sourceLinks)[0]?.url;
  // A plain <img>, not next/image: a GIF has to stay animated, and the bytes are already sized for this.
  // The caption is the alt text; a picture set before that, with alt text of its own, keeps it.
  const image = picture && (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={picture.url} alt={picture.caption ?? picture.alt ?? ''} decoding="async" className="w-full" />
  );
  return (
    <div className={ui.box}>
      {!picture && <PictureDrop canonical={canonical} paperPath={pagePath(address)} />}
      {picture && image && (
        <figure className="mb-3">
          <div className="border border-rule bg-white">
            {opens ? (
              <a
                href={opens}
                rel="noopener"
                aria-label={pdf ? 'Open the PDF' : 'Open the paper'}
                className="block"
                data-umami-event={pdf ? 'pdf_opened' : 'source_opened'}
                data-umami-event-target="picture"
              >
                {image}
              </a>
            ) : (
              image
            )}
          </div>
          {/* The page's only figure, so always the first. */}
          <figcaption className={ui.caption}>
            <b>Figure 1:</b> {picture.caption}
          </figcaption>
        </figure>
      )}
      {pdf && (
        <p>
          <a
            href={pdf.url}
            rel="noopener"
            className={ui.hyperref}
            data-umami-event="pdf_opened"
            data-umami-event-target="link"
          >
            PDF
          </a>{' '}
          {pdf.source && (
            <span className={ui.fine}>
              {pdf.license ? `${pdf.license}, from` : 'from'}{' '}
              <a
                href={pdf.source}
                rel="noopener"
                className={ui.hyperref}
                data-umami-event="source_opened"
                data-umami-event-target="pdf_source"
              >
                {sourceName(pdf.source)}
              </a>
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function Submissions({ submissions, address }: PanelProps) {
  return <SubmissionsSection submissions={submissions} paperPath={pagePath(address)} />;
}

function FactsAside({ facts, address }: PanelProps) {
  return <Facts facts={facts} pagePath={pagePath(address)} />;
}

function Versions({ versions, paper, address }: PanelProps) {
  return <VersionsSection versions={versions} paperPath={pagePath(address)} paperTitle={paper.title} />;
}

function VersionsAside({ versions, address }: PanelProps) {
  return <VersionsBox versions={versions} paperPath={pagePath(address)} />;
}

/** The discussion (DESIGN.md §9): a client island, since what it shows depends on who is reading. */
function Discussion({ canonical, address }: PanelProps) {
  return <Comments paper={canonical} path={pagePath(address)} />;
}

/** Each built-in panel, by its id in `lib/panels.ts`, which also gives its slot and its default order. */
export const PAPER_PANELS: Record<PanelId<'paper'>, ComponentType<PanelProps>> = {
  abstract: Abstract,
  sections: Sections,
  read: ReadThePaper,
  facts: FactsAside,
  'versions-box': VersionsAside,
  categories: Categories,
  links: Links,
  backlinks: Backlinks,
  versions: Versions,
  submissions: Submissions,
  discussion: Discussion,
};
