import type { ComponentType } from 'react';
import { ui } from '@/components/ui';
import type { Paper } from '@/db/schema';
import { sourceLinks, sourceName, type PaperId } from '@/lib/paper-ids';
import type { Submission } from '@/lib/submissions';
import type { PdfPointer } from '@/server/pages/rules';
import { EditablePicture } from './edit/EditablePicture';
import { EditableSection } from './edit/EditableSection';
import { toolPath } from './page-tools';
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
  /** The PDF's first page, which the picture editor falls back to. */
  cover: string | null;
  submissions: Submission[];
  /** Who has a confirmed claim, by the names on the paper. None: the paper is unclaimed. */
  confirmedAuthors: { authorIndex: number; authorName: string }[];
  /** The identifier the page's API calls name the paper by. */
  canonical: PaperId;
  /** The two Markdown sections, as rendered at their last commit. */
  authorHtml: string | null;
  communityHtml: string | null;
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

/**
 * Each section's heading gets an edit link, wiki style, which opens that section's editor in place. The
 * stored HTML (`server/pages/markdown.ts`, made at commit with raw HTML off) has only markdown-it's tags,
 * so a heading with `data-section` is always one the renderer made.
 */
function withEditLinks(html: string, part: 'author' | 'community'): string {
  return html.replace(
    /(<h3 [^>]*data-section="(\d+)"[^>]*>)([\s\S]*?)<\/h3>/g,
    (_, open: string, n: string, inner: string) =>
      `${open}${inner}<a class="section-edit" href="#edit-${part}-${n}" rel="nofollow">edit</a></h3>`,
  );
}

function names(list: string[]): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The authors' own voice, so only a paper's confirmed authors write it. A paper is claimed once one of its
 * authors is confirmed; until then the section asks them to claim it.
 */
function AuthorSection({ authorHtml, canonical, confirmedAuthors }: PanelProps) {
  const editPath = '#edit-author';
  const claimPath = toolPath('claim', canonical);
  const claimed = confirmedAuthors.length > 0;
  return (
    <section id="author">
      <h2 className={ui.groupHeading}>
        Author section
        {claimed && (
          <span className="ml-3 font-sans text-xs [font-variant-caps:normal] text-faint">
            <a href={editPath} rel="nofollow">
              edit
            </a>
          </span>
        )}
      </h2>
      {claimed ? (
        <p className={`${ui.fine} -mt-1 mb-2 font-sans`}>
          Claimed. Maintained by {names(confirmedAuthors.map((a) => a.authorName))}.{' '}
          <a href={claimPath} rel="nofollow">
            Also an author?
          </a>
        </p>
      ) : (
        <div className="py-6 text-center font-sans">
          <p className="text-sm text-muted">Are you an author? Claim the paper to write here.</p>
          {/* Set as the actions under the title are. */}
          <a href={claimPath} rel="nofollow" className="mt-1 inline-block text-[13px] text-accent">
            claim this paper
          </a>
        </div>
      )}
      <EditableSection
        paper={canonical}
        part="author"
        html={authorHtml && (claimed ? withEditLinks(authorHtml, 'author') : authorHtml)}
        claimPath={claimPath}
        empty={
          claimed ? (
            <p className={ui.empty}>
              The authors haven&apos;t written anything here yet.{' '}
              <a href={editPath} rel="nofollow">
                Start it
              </a>
              .
            </p>
          ) : null
        }
      />
    </section>
  );
}

function CommunitySection({ communityHtml, canonical }: PanelProps) {
  const editPath = '#edit-community';
  return (
    <section id="community">
      <h2 className={ui.groupHeading}>
        Community section
        <span className="ml-3 font-sans text-xs [font-variant-caps:normal] text-faint">
          <a href={editPath} rel="nofollow">
            edit
          </a>{' '}
          · <a href={toolPath('history', canonical)}>history</a>
        </span>
      </h2>
      <EditableSection
        paper={canonical}
        part="community"
        html={communityHtml && withEditLinks(communityHtml, 'community')}
        claimPath={toolPath('claim', canonical)}
        empty={
          <p className={ui.empty}>
            Nobody has written anything here yet.{' '}
            <a href={editPath} rel="nofollow">
              Start it
            </a>
            : a summary, why it matters, critique, errata, reproductions.
          </p>
        }
      />
    </section>
  );
}

function ReadThePaper({ identifiers, pdf, picture, cover, canonical }: PanelProps) {
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
      <EditablePicture paper={canonical} cover={cover} claimPath={toolPath('claim', canonical)}>
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
        <p className={`${ui.fine} -mt-1 mb-2`}>
          <a href="#edit-picture" rel="nofollow">
            {picture ? 'change the picture' : 'add a picture'}
          </a>
        </p>
      </EditablePicture>
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

function Submissions({ submissions }: PanelProps) {
  return <SubmissionsSection submissions={submissions} />;
}

function SubmissionsAside({ submissions }: PanelProps) {
  return <SubmissionsBox submissions={submissions} />;
}

const PANELS: Record<PaperSlot, ComponentType<PanelProps>[]> = {
  'paper.main': [Abstract, AuthorSection],
  'paper.aside': [ReadThePaper, SubmissionsAside],
  'paper.body': [CommunitySection, Submissions],
};

export function Slot({ name, ...props }: PanelProps & { name: PaperSlot }) {
  return PANELS[name].map((Panel, index) => <Panel key={index} {...props} />);
}
