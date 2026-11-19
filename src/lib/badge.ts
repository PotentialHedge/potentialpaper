/**
 * The embeddable SVG badge, shields.io-shaped: the site name on the accent, then the message on the page colour.
 * Pure: `app/badge/[file]/route.ts` feeds it.
 */

export interface BadgeInput {
  /** The left-hand label; omitted in the compact style. */
  label: string;
  /** The message, e.g. `ICLR 2027: under review`. */
  message: string;
  /** Hex colour of the message text. */
  color: string;
  compact?: boolean;
}

const H = 20;
const FONT = 'Verdana,Geneva,DejaVu Sans,sans-serif';
const ACCENT = '#b31b1b';
const PAPER = '#fbfaf7';
const FRAME = '#cfc8b8';
/** A message longer than this is cut, so a long title stays a badge. */
const MAX_MESSAGE = 60;

/** Verdana at 11px, near enough: the text is then fitted exactly with `textLength`. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w += 3.9;
    else if (ch === '%') w += 12;
    else if (/[0-9]/.test(ch)) w += 7;
    else if (/[ilj.,:;'|!]/.test(ch)) w += 3.5;
    else if (/[mw]/.test(ch)) w += 10.5;
    else if (/[A-Z]/.test(ch)) w += 7.8;
    else if (/[a-z]/.test(ch)) w += 6.6;
    else w += 8.5;
  }
  return Math.round(w);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderBadge(b: BadgeInput): string {
  const message = b.message.length > MAX_MESSAGE ? `${b.message.slice(0, MAX_MESSAGE - 1).trimEnd()}…` : b.message;
  const pad = 6;
  const labelW = b.compact ? 0 : textWidth(b.label) + 2 * pad;
  const msgTextW = textWidth(message);
  const msgW = msgTextW + 2 * pad;
  const width = labelW + msgW;
  const title = b.compact ? message : `${b.label}: ${message}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    `<defs><clipPath id="r"><rect width="${width}" height="${H}" rx="3"/></clipPath></defs>`,
    `<g clip-path="url(#r)">`,
    b.compact ? '' : `<rect width="${labelW}" height="${H}" fill="${ACCENT}"/>`,
    `<rect x="${labelW}" width="${msgW}" height="${H}" fill="${PAPER}"/>`,
    `</g>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${H - 1}" rx="2.5" fill="none" stroke="${b.compact ? FRAME : ACCENT}"/>`,
    `<g font-family="${FONT}" font-size="11">`,
    b.compact
      ? ''
      : `<text x="${pad}" y="14" fill="#fff" textLength="${labelW - 2 * pad}" lengthAdjust="spacingAndGlyphs">${esc(b.label)}</text>`,
    `<text x="${labelW + pad}" y="14" fill="${b.color}" font-weight="bold" textLength="${msgTextW}" lengthAdjust="spacingAndGlyphs">${esc(message)}</text>`,
    `</g>`,
    `</svg>`,
  ].join('');
}
