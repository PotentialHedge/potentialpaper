import type { ComponentType, ReactNode } from 'react';
import { ArrangedPanels } from '@/components/ArrangedPanels';
import { ArrangedTabs } from '@/components/ArrangedTabs';
import { LinksBox } from '@/components/pages/LinkLists';
import { AddTopic } from '@/components/topics/AddTopic';
import { formatIdentifier, pagePath } from '@/lib/kinds';
import { TOPIC_LABELS } from '@/lib/labeled-links';
import { ui } from '@/components/ui';
import { type PanelId, slotPanels } from '@/lib/panels';
import type { PageLink } from '@/server/page-links';
import type { Paper } from '@/db/schema';
import { paperPath, sourceLinks, sourceName, type PaperId } from '@/lib/paper-ids';
import { Comments } from './Comments';
import type { Submission } from '@/lib/submissions';
import type { PdfPointer } from '@/server/pages/rules';
import { toolPath } from './page-tools';
import { SubmissionsBox, SubmissionsSection } from './Submissions';
import { VersionsBox, VersionsSection } from './Versions';
import type { PaperVersion } from '@/lib/versions';
import { Fold } from '@/components/paper/Fold';
import { AuthorPanels, CommunityPanels } from '@/components/plugins/NestedPanels';

/**
 * A paper page is assembled from named slots, so that built-in panels can later become the first
 * extensions (DESIGN.md §10). Panels render the same HTML for every reader, because the edge caches the
 * page: anything about the viewer belongs in a client island. The paper is the first kind of page
 * (`lib/kinds.ts`): its slots are every kind's `paper.main`, `paper.aside` and `paper.tabs`, and its own
 * `paper.body` (and the title's links). Other kinds' panels are in `components/pages/slots.tsx`.
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
  /** The page's `versions/`, oldest first. */
  versions: PaperVersion[];
  /** Who has a confirmed claim, by the names on the paper. None: the paper is unclaimed. */
  confirmedAuthors: { authorIndex: number; authorName: string }[];
  /** The identifier the page's API calls name the paper by. */
  canonical: PaperId;
  /** The two Markdown sections, as rendered at their last commit. */
  authorHtml: string | null;
  communityHtml: string | null;
  /** Its labeled links, and the links to it ("what links here"), on pages of any kind (`server/page-links.ts`). */
  linksFrom: PageLink[];
  linksTo: PageLink[];
}

/**
 * `paper.main` sits beside `paper.aside`; `paper.body` follows both, across the page. Together they are the "Paper" tab,
 * which `paper.tabs` panels are tabs beside, each shown in its place.
 */
export type PaperSlot = 'paper.main' | 'paper.aside' | 'paper.body' | 'paper.tabs';

function Abstract({ paper }: PanelProps) {
  return (
    <p>
      <b>Abstract.</b>{' '}
      {paper.abstract ?? <span className="text-muted italic">We can&apos;t show this paper&apos;s abstract here.</span>}
    </p>
  );
}

/** Opens the Edit dialog (`EditDialog`), from anywhere on the page. */
const EDIT = '#edit';

/** A part's rendered HTML (`server/pages/markdown.ts`, made at commit), or what to say while it is empty. */
function PartHtml({ html, empty }: { html: string | null; empty: React.ReactNode }) {
  return html ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : empty;
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
  const editPath = EDIT;
  const claimPath = toolPath('claim', canonical);
  const claimed = confirmedAuthors.length > 0;
  return (
    <Fold
      id="author"
      title="Author section"
      extra={
        claimed && (
          <span className="ml-3 font-sans text-xs [font-variant-caps:normal] text-faint">
            <a href={editPath} rel="nofollow">
              edit
            </a>
          </span>
        )
      }
    >
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
      <PartHtml
        html={authorHtml}
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
      {/* The plugins' panels its authors let in (`paper.author`, `author/plugins.json`). */}
      <AuthorPanels />
    </Fold>
  );
}

function CommunitySection({ communityHtml, canonical }: PanelProps) {
  const editPath = EDIT;
  return (
    <Fold
      id="community"
      title="Community section"
      extra={
        <>
          <span className="ml-3 font-sans text-xs [font-variant-caps:normal] text-faint">
            <a href={editPath} rel="nofollow">
              edit
            </a>{' '}
            · <a href={toolPath('history', canonical)}>history</a>
          </span>
        </>
      }
    >
      <PartHtml
        html={communityHtml}
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
      {/* Plugins' panels in the community section (`paper.community`): the paper map's minimap. */}
      <CommunityPanels />
    </Fold>
  );
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

function Versions({ versions, canonical, paper, submissions }: PanelProps) {
  return (
    <VersionsSection
      versions={versions}
      canonical={canonical}
      paperTitle={paper.title}
      submissionUrls={submissions.map((s) => s.url)}
    />
  );
}

function VersionsAside({ versions }: PanelProps) {
  return <VersionsBox versions={versions} />;
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
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>Topics</h2>
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
      <AddTopic identifier={`${canonical.scheme}:${canonical.value}`} />
    </div>
  );
}

function Backlinks({ linksTo }: PanelProps) {
  return <LinksBox links={linksTo} direction="to" />;
}

/** Each built-in panel, by its id in `lib/panels.ts`, which also gives its slot and its default order. */
const PANELS: Record<PanelId<'paper'>, ComponentType<PanelProps>> = {
  abstract: Abstract,
  author: AuthorSection,
  read: ReadThePaper,
  'versions-box': VersionsAside,
  'submissions-box': SubmissionsAside,
  topics: Topics,
  links: Links,
  backlinks: Backlinks,
  community: CommunitySection,
  versions: Versions,
  submissions: Submissions,
  discussion: Discussion,
};

/** A slot's panels, which the reader's settings may hide or reorder (`ArrangedPanels`). */
export function Slot({ name, lead, ...props }: PanelProps & { name: PaperSlot; lead?: ReactNode }) {
  const panels = slotPanels('paper', name).map(({ id, title }) => {
    const Panel = PANELS[id];
    return { id, title, node: <Panel {...props} /> };
  });
  if (name === 'paper.tabs')
    return (
      <ArrangedTabs kind="paper" slot={name} panels={panels} lead={lead ? { title: 'Paper', node: lead } : undefined} />
    );
  return <ArrangedPanels kind="paper" slot={name} panels={panels} />;
}
