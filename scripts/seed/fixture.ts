import type { NoteInput } from '@/server/import-reviews';
import type { SubmissionStatus } from '@/lib/submissions';

/** The dev fixture: a few real papers per venue, with what OpenReview published about them. */
export const FIXTURE_PATH = 'scripts/seed/fixture.json';

/** A note as JSON keeps it: dates as strings. */
export type FixtureNote = Omit<NoteInput, 'createdAt' | 'modifiedAt'> & {
  createdAt: string;
  modifiedAt: string | null;
};

export interface FixturePaper {
  /** The OpenReview forum id. */
  id: string;
  number: number | null;
  title: string;
  abstract: string;
  /** Empty while the venue is under review. */
  authors: string[];
  keywords: string[];
  status: SubmissionStatus | null;
  decision: string | null;
  notes: (FixtureNote | NoteInput)[];
}

export interface FixtureVenue {
  /** OpenReview's group: `ICLR.cc/2026/Conference`. */
  group: string;
  name: string;
  year: number;
  /** Under review: no authors, and the papers are named "<name> (under review)". */
  anonymous: boolean;
  papers: FixturePaper[];
}

export interface Fixture {
  venues: FixtureVenue[];
}
