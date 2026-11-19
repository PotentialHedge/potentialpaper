import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { ImageResponse } from 'next/og';
import type { ShareSubject } from './share';

/**
 * The link-preview images: a page's (`app/preview/[file]`), its name, authors and venue, and the site's own
 * (`app/opengraph-image.tsx`), which every page without one inherits. Set in the site's serif on the page colour,
 * under the accent rule. Nothing here writes.
 */

export const OG_SIZE = { width: 1200, height: 630 };

const INK = '#1d1d1d';
const MUTED = '#777';
const ACCENT = '#b31b1b';
const PAPER = '#fbfaf7';

let serif: Promise<Buffer> | null = null;
/** Liberation Serif (OFL, `assets/fonts/`): Times metrics, Latin only. */
function serifFont(): Promise<Buffer> {
  serif ??= readFile(join(process.cwd(), 'assets/fonts/LiberationSerif-Regular.ttf'));
  return serif;
}

/** Cut to `max` characters at a word, with an ellipsis. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, '')}…`;
}

/** The first authors, then "et al." so the line stays short. */
function authorLine(authors: readonly string[]): string | null {
  if (authors.length === 0) return null;
  const shown = authors.slice(0, 4).join(', ');
  return cut(authors.length > 4 ? `${shown}, et al.` : shown, 140);
}

/** A page's preview: its name, a paper's authors, and the line under them. */
export async function previewImage(subject: ShareSubject, host: string): Promise<ImageResponse> {
  const title = cut(subject.name, 150);
  const titleSize = title.length > 90 ? 52 : title.length > 50 ? 60 : 68;
  const authors = authorLine(subject.authors);
  return card(
    subject.kindTitle,
    <div style={BODY}>
      <div
        style={{
          display: 'flex',
          marginTop: 44,
          fontSize: titleSize,
          lineHeight: 1.15,
          maxHeight: 250,
          overflow: 'hidden',
        }}
      >
        {title}
      </div>
      {authors && <div style={{ display: 'flex', marginTop: 24, fontSize: 32, lineHeight: 1.3 }}>{authors}</div>}
      <div style={{ display: 'flex', flex: 1 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 28, color: MUTED }}>
        <div style={{ display: 'flex' }}>{subject.about ?? ''}</div>
        <div style={{ display: 'flex' }}>{`${host}/s/${subject.shortId}`}</div>
      </div>
    </div>,
  );
}

/** The site's own preview, for the home page and every page without one of its own. */
export async function siteImage(): Promise<ImageResponse> {
  return card(
    '',
    <div style={BODY}>
      <div style={{ display: 'flex', marginTop: 64, fontSize: 72, lineHeight: 1.1 }}>
        A public, editable page for every research paper
      </div>
      <div style={{ display: 'flex', marginTop: 28, fontSize: 34, lineHeight: 1.3, color: MUTED }}>
        Its reviews, versions, code and discussion, with labeled links between papers.
      </div>
    </div>,
  );
}

/** Column children, never a fragment, which Satori lays out as a row. */
const BODY = { display: 'flex', flexDirection: 'column', flex: 1 } as const;

/** Every preview's frame: the accent rule, the logo and name, and `corner` opposite them. */
async function card(corner: string, children: ReactNode): Promise<ImageResponse> {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: PAPER,
        padding: '52px 72px',
        color: INK,
        fontFamily: 'Serif',
        borderTop: `12px solid ${ACCENT}`,
      }}
    >
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 30, color: MUTED }}
      >
        <div style={{ display: 'flex', alignItems: 'center', fontSize: 38, color: INK }}>
          <svg viewBox="0 0 24 24" width={38} height={38} style={{ marginRight: 14 }}>
            <path d="M5 19 12 5l7 14" fill="none" stroke={ACCENT} strokeWidth="2.25" />
            <circle cx="5" cy="19" r="3.5" fill={ACCENT} />
            <circle cx="12" cy="5" r="3.5" fill={ACCENT} />
            <circle cx="19" cy="19" r="3.5" fill={ACCENT} />
          </svg>
          potential<span style={{ color: ACCENT }}>paper</span>
        </div>
        <div style={{ display: 'flex' }}>{corner}</div>
      </div>
      {children}
    </div>,
    {
      ...OG_SIZE,
      fonts: [{ name: 'Serif', data: await serifFont(), style: 'normal', weight: 400 }],
      // Crawlers fetch previews hard, and chat apps cache the card anyway; an hour is fresh enough.
      headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' },
    },
  );
}
