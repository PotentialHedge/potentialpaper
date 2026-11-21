import type { PaperId } from '@/lib/paper-ids';
import type { VersionKind } from '@/lib/versions';
import type { RateLimitConfig } from '../ratelimit';

/** Where a paper's row came from. */
export const PAPER_ORIGINS = ['arxiv', 'openalex', 'openreview'] as const;
export type PaperOrigin = (typeof PAPER_ORIGINS)[number];

/**
 * The license of what a source gave us, as an SPDX id where the source names a version, and as the
 * source's own label otherwise (OpenAlex says `cc-by`). Every item copied from elsewhere records one.
 */
export type License = string;

/** arXiv, OpenReview and OpenAlex each dedicate their metadata, abstracts included for the first two, to CC0. */
export const CC0: License = 'CC0-1.0';

/** A version as a source describes it, which the lookup commits as the paper's first versions. */
export interface SourceVersion {
  label: string;
  kind: VersionKind;
  date?: string;
  url?: string;
}

/** A paper as a source describes it. `identifiers` includes the one asked for. */
export interface SourcePaper {
  title: string;
  authors: string[];
  abstract: string | null;
  year: number | null;
  venue: string | null;
  identifiers: PaperId[];
  source: PaperOrigin;
  /** Of the title, authors, year, venue and identifiers. */
  metadataLicense: License;
  /** `null` exactly when there is no abstract. */
  abstractLicense: License | null;
  /**
   * The versions the source knows of, oldest first, which a paper new here starts with: a paper always has at
   * least one. Whoever knows more (`import-versions`, an editor) adds the rest.
   */
  versions: SourceVersion[];
}

/** The source could not answer: try later, and do not remember this as a miss. */
export class SourceUnavailable extends Error {}

export interface PaperSource {
  name: string;
  /** Shared by every reader, so that crawlers cannot make us exceed what the source allows. */
  budget: RateLimitConfig;
  /** The paper, or `null` when the source says there is no such paper. */
  fetch(value: string): Promise<SourcePaper | null>;
}

const TIMEOUT_MS = 8_000;

/** A request to a source. A 404 is `null`; anything else that is not a 200 is `SourceUnavailable`. */
export async function fetchSource(url: string): Promise<Response | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'PotentialPaper (https://papers.potentialhedge.com)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SourceUnavailable(`${url}: ${String(err)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new SourceUnavailable(`${url}: HTTP ${res.status}`);
  return res;
}

export function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
