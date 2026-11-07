import type { ComponentType } from 'react';
import { ui } from '@/components/ui';
import type { Paper } from '@/db/schema';
import { sourceLinks, sourceName, type PaperId } from '@/lib/paper-ids';
import type { DemoPointer } from '@/lib/demos';
import type { Submission } from '@/lib/submissions';
import type { PdfPointer } from '@/server/pages/rules';
import { DemosSection } from './Demos';
import { SubmissionsBox, SubmissionsSection } from './Submissions';

/**
 * A paper page is assembled from named slots, so that built-in panels can later become the first
 * extensions (DESIGN.md §10). Panels render the same HTML for every reader, because the edge caches the
 * page: anything about the viewer belongs in a client island.
 */

export interface PanelProps {
  paper: Paper;
  identifiers: PaperId[];
  pdf: PdfPointer | null;
  /** The authors' thumbnail, or else the PDF's first page. */
  picture: { url: string; alt: string | null; caption: string } | null;
  submissions: Submission[];
  /** The page's demos, in order. */
  demos: DemoPointer[];
  /** The identifier the page's API calls name the paper by. */
  canonical: PaperId;
}

/** `paper.main` sits beside `paper.aside`; `paper.body` follows both, across the page. */
export type PaperSlot = 'paper.main' | 'paper.aside' | 'paper.body';

function Abstract({ paper }: PanelProps) {
  return (
    <p>
      <b>Abstract.</b>{' '}
      {paper.abstract ?? <span className="text-muted italic">We can&apos;t show this paper&apos;s abstract here.</span>}
    </p>
  );
}

function AuthorSection() {
  return (
    <section>
      <h2 className={ui.groupHeading}>Author section</h2>
      <p className={ui.empty}>The authors haven&apos;t written anything here yet.</p>
    </section>
  );
}

function CommunitySection() {
  return (
    <section>
      <h2 className={ui.groupHeading}>Community section</h2>
      <p className={ui.empty}>Nobody has written anything here yet.</p>
    </section>
  );
}

function ReadThePaper({ identifiers, pdf, picture }: PanelProps) {
  // The PDF's credit already links its source, which is often the paper's own page there.
  const links = identifiers.flatMap(sourceLinks).filter(({ url }) => url !== pdf?.source);
  const opens = pdf?.url ?? links[0]?.url;
  // A plain <img>, not next/image: a GIF has to stay animated, and the bytes are already sized for this.
  // eslint-disable-next-line @next/next/no-img-element
  const image = picture && <img src={picture.url} alt={picture.alt ?? ''} decoding="async" className="w-full" />;
  return (
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>Read the paper</h2>
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
            <span className={ui.fine}>
              {pdf.license}, from{' '}
              <a href={pdf.source} rel="noopener" className={ui.hyperref}>
                {sourceName(pdf.source)}
              </a>
            </span>
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

function Demos({ demos, canonical }: PanelProps) {
  return <DemosSection demos={demos} paper={canonical} />;
}

function Submissions({ submissions }: PanelProps) {
  return <SubmissionsSection submissions={submissions} />;
}

function SubmissionsAside({ submissions }: PanelProps) {
  return <SubmissionsBox submissions={submissions} />;
}

const PANELS: Record<PaperSlot, ComponentType<PanelProps>[]> = {
  'paper.main': [Abstract, AuthorSection],
  'paper.aside': [ReadThePaper, SubmissionsAside],
  'paper.body': [Demos, CommunitySection, Submissions],
};

export function Slot({ name, ...props }: PanelProps & { name: PaperSlot }) {
  return PANELS[name].map((Panel, index) => <Panel key={index} {...props} />);
}
