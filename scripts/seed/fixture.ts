import type { NoteInput } from '@/server/import-reviews';
import type { SubmissionStatus, VenueForms } from '@/lib/submissions';

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
  /** When it was submitted (ISO 8601), from the scrape's `cdate`, where it has one. */
  submittedAt?: string;
  status: SubmissionStatus | null;
  decision: string | null;
  notes: (FixtureNote | NoteInput)[];
  /** Added to fill out the venue's score distribution, with its reviewers' scores only (`seed:acceptodds-reviews` in `potentialpaper-tools`). */
  sample?: boolean;
  /** Was at an earlier fixture venue too, and added for that (`seed:acceptodds-reviews --resubmissions` there). */
  resubmission?: boolean;
}

export interface FixtureVenue {
  /** OpenReview's group: `ICLR.cc/2026/Conference`. */
  group: string;
  name: string;
  year: number;
  /** Its page on OpenReview. */
  url: string;
  /** The license of its notes. */
  license: string;
  /** How to show each kind of its notes, by OpenReview's name for it. */
  forms: VenueForms;
  /** Under review: no authors, and the papers are named "<name> (under review)". */
  anonymous: boolean;
  papers: FixturePaper[];
}

export interface Fixture {
  venues: FixtureVenue[];
}
