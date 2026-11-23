import type { PageFacts } from './infobox-facts';
import { keyedPagePath } from './kinds';
import { sourceLinks, type PaperId } from './paper-ids';
import { reviewsKey } from './review-files';
import type { Submission, SubmissionStatus } from './submissions';
import { sortVersions, type PaperVersion } from './versions';
import { venuePlace } from './venues';

/**
 * A paper's facts, as its infobox (`components/paper/Facts.tsx`), its JSON-LD and its `citation_*` meta tags all show
 * them (`components/paper/paper-route.tsx`). Each fact is read from the one place it is kept: where a version went,
 * what the venue decided and where it is presented from the versions (`lib/versions.ts`); the keywords from the
 * venues' submissions (`submission.json`); the identifiers from the paper's. Nothing here stores anything. Pure.
 */

export interface VenueFact {
  /** "NeurIPS 2026". */
  venue: string;
  /** Its page here, `/v/neurips/2026`, when the venue's submissions come from a source we import. */
  path: string | null;
  status: SubmissionStatus | null;
  /** "Poster", "Oral": the part in brackets of the decision "Accept (Poster)", when it has one. */
  presentation: string | null;
  /** "Sydney". */
  site: string | null;
  /** When the version went there: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  date: string | null;
}

export interface PaperFacts {
  title: string;
  authors: string[];
  abstract: string | null;
  /** Where it was sent, newest first. */
  venues: VenueFact[];
  /** The venue it was accepted at, newest first: what it is published as. */
  published: VenueFact | null;
  /** The earliest date of any version: when the work was first made public or submitted. */
  firstDate: string | null;
  keywords: string[];
  /**
   * The area its authors chose from its newest venue's list, with that venue: a fact about the submission, shown as
   * the venue words it, never one of the site's categories.
   */
  area: { name: string; venue: string } | null;
  /** Its one-sentence summary, from its newest submission that has one. */
  tldr: string | null;
  /** The rows its authors and the community added (`owners/facts.jsonl`, `community/facts.jsonl`). */
  own: PageFacts;
  /** Its addresses elsewhere: arXiv, DOI, OpenReview. */
  identifiers: { label: string; url: string }[];
  pdf: string | null;
}

/** "Accept (Poster)" → "Poster"; "Reject" → `null`, as the status already says it. */
function presentationOf(decision: string | undefined): string | null {
  if (!decision) return null;
  const inner = /\(([^)]+)\)/.exec(decision)?.[1]?.trim();
  return inner ? inner.charAt(0).toUpperCase() + inner.slice(1) : null;
}

/** The venue page of an imported submission, by its reviews folder (`openreview/abc123`). */
function venuePaths(submissions: readonly Submission[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const s of submissions) {
    const colon = s.venue.id.indexOf(':');
    const place = venuePlace(s.venue.id, s.venue.name);
    if (colon > 0 && place)
      paths.set(reviewsKey(s.venue.id.slice(0, colon), s.externalId), keyedPagePath('venue', place.edition.key));
  }
  return paths;
}

/** Submissions come newest first (`server/submissions.ts`). */
function areaOf(submissions: readonly Submission[]): PaperFacts['area'] {
  const s = submissions.find((x) => x.primaryArea);
  if (!s?.primaryArea) return null;
  return { name: s.primaryArea.charAt(0).toUpperCase() + s.primaryArea.slice(1), venue: s.venue.name };
}

export function paperFacts({
  paper,
  versions,
  submissions,
  identifiers,
  pdf,
  own = null,
}: {
  paper: { title: string; authors: string[]; abstract: string | null };
  versions: readonly PaperVersion[];
  submissions: readonly Submission[];
  identifiers: readonly PaperId[];
  pdf: string | null;
  own?: PageFacts | null;
}): PaperFacts {
  const sorted = sortVersions(versions);
  const paths = venuePaths(submissions);
  const venues = sorted
    .flatMap((v) =>
      (v.submissions ?? []).map((s): VenueFact => ({
        venue: s.venue,
        path: (s.reviews && paths.get(s.reviews)) ?? null,
        status: s.status ?? null,
        presentation: presentationOf(s.decision),
        site: s.site ?? null,
        date: v.date ?? null,
      })),
    )
    .reverse();
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const keyword of submissions.flatMap((s) => s.keywords)) {
    if (seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    keywords.push(keyword);
  }
  return {
    title: paper.title,
    authors: paper.authors,
    abstract: paper.abstract,
    venues,
    published: venues.find((v) => v.status === 'accepted') ?? null,
    firstDate: sorted.find((v) => v.date)?.date ?? null,
    keywords,
    area: areaOf(submissions),
    tldr: submissions.find((s) => s.tldr)?.tldr ?? null,
    own: own ?? { owners: [], community: [] },
    identifiers: identifiers.flatMap(sourceLinks).filter((l) => l.label !== 'PDF'),
    pdf,
  };
}

/** What a submission came to, as an infobox row's label: "Accepted at". */
export const VENUE_ROW_LABEL: Record<SubmissionStatus | 'unknown', string> = {
  accepted: 'Accepted at',
  under_review: 'Under review at',
  rejected: 'Rejected at',
  withdrawn: 'Withdrawn from',
  desk_rejected: 'Desk rejected at',
  unknown: 'Submitted to',
};

/** `YYYY-MM-DD` as Google Scholar asks for it: `YYYY/MM/DD`, as much of it as is known. */
function scholarDate(date: string): string {
  return date.replace(/-/g, '/');
}

/**
 * The Highwire Press tags Google Scholar indexes a paper by (scholar.google.com/intl/en/scholar/inclusion.html):
 * one `citation_author` per author, in order. As pairs, since a name repeats.
 */
export function citationTags(facts: PaperFacts): [string, string][] {
  const tags: [string, string][] = [['citation_title', facts.title]];
  for (const author of facts.authors) tags.push(['citation_author', author]);
  if (facts.firstDate) tags.push(['citation_publication_date', scholarDate(facts.firstDate)]);
  if (facts.published) tags.push(['citation_conference_title', facts.published.venue]);
  if (facts.pdf) tags.push(['citation_pdf_url', facts.pdf]);
  const arxiv = facts.identifiers.find((i) => i.url.startsWith('https://arxiv.org/abs/'));
  if (arxiv) tags.push(['citation_arxiv_id', arxiv.url.slice('https://arxiv.org/abs/'.length)]);
  const doi = facts.identifiers.find((i) => i.url.startsWith('https://doi.org/'));
  if (doi) tags.push(['citation_doi', doi.url.slice('https://doi.org/'.length)]);
  if (facts.keywords.length > 0) tags.push(['citation_keywords', facts.keywords.join('; ')]);
  return tags;
}

/** schema.org's `ScholarlyArticle`, for search engines (`<script type="application/ld+json">`). */
export function paperJsonLd(facts: PaperFacts, url: string, siteUrl: string): Record<string, unknown> {
  const venue = facts.published;
  return {
    '@context': 'https://schema.org',
    '@type': 'ScholarlyArticle',
    headline: facts.title.slice(0, 110),
    name: facts.title,
    url,
    ...(facts.authors.length > 0 ? { author: facts.authors.map((name) => ({ '@type': 'Person', name })) } : {}),
    ...(facts.abstract ? { abstract: facts.abstract } : {}),
    ...(facts.tldr ? { description: facts.tldr } : {}),
    ...(facts.area ? { about: { '@type': 'Thing', name: facts.area.name } } : {}),
    ...(facts.firstDate ? { datePublished: facts.firstDate } : {}),
    ...(facts.keywords.length > 0 ? { keywords: facts.keywords.join(', ') } : {}),
    ...(venue
      ? {
          isPartOf: {
            '@type': 'Event',
            name: venue.venue,
            ...(venue.path ? { url: `${siteUrl}${venue.path}` } : {}),
            ...(venue.site ? { location: { '@type': 'Place', name: venue.site } } : {}),
          },
        }
      : {}),
    ...(facts.identifiers.length > 0 ? { sameAs: facts.identifiers.map((i) => i.url) } : {}),
    ...(facts.pdf
      ? { encoding: { '@type': 'MediaObject', encodingFormat: 'application/pdf', contentUrl: facts.pdf } }
      : {}),
  };
}
