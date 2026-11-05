import type { ComponentType } from 'react';
import { ui } from '@/components/ui';
import type { Paper } from '@/db/schema';
import { sourceLinks, type PaperId } from '@/lib/paper-ids';
import type { PdfPointer } from '@/server/pages/rules';

/**
 * A paper page is assembled from named slots, so that built-in panels can later become the first
 * extensions (DESIGN.md §10). Panels render the same HTML for every reader, because the edge caches the
 * page: anything about the viewer belongs in a client island.
 */

export interface PanelProps {
  paper: Paper;
  identifiers: PaperId[];
  pdf: PdfPointer | null;
}

export type PaperSlot = 'paper.main' | 'paper.aside';

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

function ReadThePaper({ identifiers, pdf }: PanelProps) {
  return (
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>Read the paper</h2>
      <ul className="space-y-1">
        {pdf && (
          <li>
            <a href={pdf.url} rel="noopener" className={ui.hyperref}>
              PDF
            </a>{' '}
            <span className={ui.fine}>
              {pdf.license}, from{' '}
              <a href={pdf.source} rel="noopener" className={ui.hyperref}>
                the source
              </a>
            </span>
          </li>
        )}
        {identifiers.flatMap(sourceLinks).map(({ label, url }) => (
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

const PANELS: Record<PaperSlot, ComponentType<PanelProps>[]> = {
  'paper.main': [Abstract, AuthorSection, CommunitySection],
  'paper.aside': [ReadThePaper],
};

export function Slot({ name, ...props }: PanelProps & { name: PaperSlot }) {
  return PANELS[name].map((Panel, index) => <Panel key={index} {...props} />);
}
