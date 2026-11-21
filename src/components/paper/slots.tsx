import type { ComponentType } from 'react';
import { AddTopic } from '@/components/topics/AddTopic';
import { Backlinks, type PageCommon, Sections } from '@/components/pages/common';
import { LinksBox } from '@/components/pages/LinkLists';
import { formatIdentifier, pagePath } from '@/lib/kinds';
import { TOPIC_LABELS } from '@/lib/labeled-links';
import { ui } from '@/components/ui';
import type { PanelId } from '@/lib/panels';
import { AbstractText } from '@/components/AbstractText';
import type { Paper } from '@/db/schema';
import { paperPath, sourceLinks, sourceName, type PaperId } from '@/lib/paper-ids';
import { Comments } from './Comments';
import type { Submission } from '@/lib/submissions';
import type { PdfPointer } from '@/server/pages/rules';
import { SubmissionsBox, SubmissionsSection } from './Submissions';
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
}

/** Its Markdown and TeX rendered, with "Abstract." run into its first paragraph. */
function Abstract({ paper }: PanelProps) {
  if (!paper.abstract) {
    return (
      <p>
        <b>Abstract.</b> <span className="text-muted italic">We can&apos;t show this paper&apos;s abstract here.</span>
      </p>
    );
  }
  return <AbstractText text={paper.abstract} />;
}

function ReadThePaper({ identifiers, pdf, picture }: PanelProps) {
  // The PDF and its credit already link the file and its source, which are often the paper's own there.
  const links = identifiers.flatMap(sourceLinks).filter(({ url }) => url !== pdf?.source && url !== pdf?.url);
  const opens = pdf?.url ?? links[0]?.url;
  // A plain <img>, not next/image: a GIF has to stay animated, and the bytes are already sized for this.
  // The caption is the alt text; a picture set before that, with alt text of its own, keeps it.
  const image = picture && (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={picture.url} alt={picture.caption ?? picture.alt ?? ''} decoding="async" className="w-full" />
  );
  return (
    <div className={ui.box}>
      {picture && image && (
        <figure className="mb-3">
          <div className="border border-rule bg-white">
            {opens ? (
              <a href={opens} rel="noopener" aria-label={pdf ? 'Open the PDF' : 'Open the paper'} className="block">
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
      <ul className="space-y-1">
        {pdf && (
          <li>
            <a href={pdf.url} rel="noopener" className={ui.hyperref}>
              PDF
            </a>{' '}
            {pdf.source && (
              <span className={ui.fine}>
                {pdf.license ? `${pdf.license}, from` : 'from'}{' '}
                <a href={pdf.source} rel="noopener" className={ui.hyperref}>
                  {sourceName(pdf.source)}
                </a>
              </span>
            )}
          </li>
        )}
        {links.map(({ label, url }) => (
          <li key={url}>
            <a href={url} rel="noopener" className={ui.hyperref}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Submissions({ submissions, canonical }: PanelProps) {
  return <SubmissionsSection submissions={submissions} paperPath={paperPath(canonical)} />;
}

function SubmissionsAside({ submissions, canonical }: PanelProps) {
  return <SubmissionsBox submissions={submissions} paperPath={paperPath(canonical)} />;
}

function Versions({ versions, canonical, paper }: PanelProps) {
  return <VersionsSection versions={versions} canonical={canonical} paperTitle={paper.title} />;
}

function VersionsAside({ versions, canonical }: PanelProps) {
  return <VersionsBox versions={versions} paperPath={paperPath(canonical)} />;
}

/** The discussion (DESIGN.md §9): a client island, since what it shows depends on who is reading. */
function Discussion({ canonical }: PanelProps) {
  return <Comments paper={canonical} path={paperPath(canonical)} />;
}

/** Its labeled links, but for its topics, which the Topics box shows. */
function Links({ linksFrom }: PanelProps) {
  return <LinksBox links={linksFrom.filter((link) => !TOPIC_LABELS.includes(link.label))} direction="from" />;
}

/**
 * The topics it is in (its `in-topic` and `introduces-topic` links, `handoffs/pages.md` Phase 5), and "Add a topic",
 * which links it to one by name, making the topic if none has that name yet.
 */
function Topics({ linksFrom, canonical }: PanelProps) {
  const topics = linksFrom.filter((link) => TOPIC_LABELS.includes(link.label));
  return (
    <AddTopic identifier={`${canonical.scheme}:${canonical.value}`}>
      {topics.length > 0 ? (
        <ul className="space-y-1">
          {topics.map((link, i) => (
            <li key={i}>
              {link.page.address ? (
                <a href={pagePath(link.page.address)} className={link.page.name ? 'text-ink' : 'text-muted italic'}>
                  {link.page.name ?? formatIdentifier(link.page.address)}
                </a>
              ) : (
                link.page.name
              )}
              {link.label === 'introduces-topic' && <span className={ui.badge}>introduced it</span>}
              {link.origin === 'owners' && <span className={ui.badge}>authors</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">Not in a topic yet.</p>
      )}
    </AddTopic>
  );
}

/** Each built-in panel, by its id in `lib/panels.ts`, which also gives its slot and its default order. */
export const PAPER_PANELS: Record<PanelId<'paper'>, ComponentType<PanelProps>> = {
  abstract: Abstract,
  sections: Sections,
  read: ReadThePaper,
  'versions-box': VersionsAside,
  'submissions-box': SubmissionsAside,
  topics: Topics,
  links: Links,
  backlinks: Backlinks,
  versions: Versions,
  submissions: Submissions,
  discussion: Discussion,
};
