import type { PaperId } from '@/lib/paper-ids';
import type { RateLimitConfig } from '../ratelimit';

/** A paper as a source describes it. `identifiers` includes the one asked for. */
export interface SourcePaper {
  title: string;
  authors: string[];
  abstract: string | null;
  year: number | null;
  venue: string | null;
  identifiers: PaperId[];
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
