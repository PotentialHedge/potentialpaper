import { z } from 'zod';
import { getDb } from '@/db';
import { MAX_EVIDENCE_URL } from '@/lib/evidence';
import { linkFileSchema, MAX_LINKS } from '@/lib/paper-links';
import { PAPER_SCHEMES } from '@/lib/paper-ids';
import { NOTE_KINDS, SUBMISSION_STATUSES, type VenueForms } from '@/lib/submissions';
import { requireAuth } from '../auth';
import { IMPORT_RATE_LIMIT, importReviews } from '../import-reviews';
import { importPresentations } from '../import-presentations';
import { importSubmissions } from '../import-submissions';
import { importLinks, importPapers, importPdf, importsFrom, importVersions, requireImporter } from '../imports';
import type { CommitResult } from '../pages/commit';
import { refreshPageIds, refreshPaperPages } from '../pages/refresh';
import { syncVenuePages } from '../venue-pages';
import { ApiError } from './errors';
import { parseBody, parseQuery, respond, route } from './http';
import { presentationSchema } from '@/lib/versions';
import { PaperIdentifier, VersionFields, VersionPdf } from './schemas';

/**
 * `/api/v1/imports/*`, for import tools only (`server/imports.ts`): a bot's API token, never a person's. Described
 * for them at `/agent/imports`.
 */

const MAX_PAPERS = 500;
const MAX_IMPORT_SUBMISSIONS = 100;
const MAX_NOTES = 500;

const Url = z.string().url().max(MAX_EVIDENCE_URL);
const Source = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const FieldValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const ImportPapersQuery = z.object({
  scheme: z.enum(PAPER_SCHEMES),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const ImportPaper = z.object({
  id: z.string(),
  identifiers: z.array(z.object({ scheme: z.string(), value: z.string() })),
  title: z.string(),
  abstract: z.string().nullable(),
  venue: z.string().nullable(),
  year: z.number().nullable(),
  pdf: VersionPdf.nullable(),
});
export const ImportPapersList = z.object({ papers: z.array(ImportPaper), next: z.string().nullable() });

/**
 * New papers, by their OpenReview id. One already here is left as it is, except that one imported while anonymous is
 * given the authors sent once none of its submissions is under review any more (withdrawn, desk-rejected or decided). Where each went is its versions'
 * (`/imports/submissions`, `/imports/versions`), not the paper's.
 */
export const ImportPapersBody = z.object({
  papers: z
    .array(
      z.object({
        openreview: z.string().min(1).max(100),
        title: z.string().max(2000),
        abstract: z.string().max(20_000).nullable(),
        /** Left out while the venue's review is anonymous. */
        authors: z.array(z.string().max(300)).max(500).optional(),
      }),
    )
    .max(MAX_PAPERS),
});
/** `named`: papers already here, imported while anonymous, whose authors it gave now that their review has ended. */
export const ImportedPapers = z.object({ added: z.number().int(), named: z.number().int() });

const Note = z.object({
  externalId: z.string().min(1).max(200),
  replyTo: z.string().max(200).nullable(),
  kind: z.enum(NOTE_KINDS),
  invitation: z.string().max(200),
  signature: z.string().max(200),
  content: z.record(z.string(), FieldValue),
  license: z.string().max(100),
  url: Url.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
});

/** A venue's submissions with what it published about them: each becomes its folder in the paper's repo. */
export const ImportSubmissionsBody = z.object({
  venue: z.object({
    source: Source,
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    url: Url.nullable(),
    /** How to show each kind of note, by the source's name for it: kept in the venue page's `forms.json`. */
    forms: z.record(z.string(), z.unknown()).default({}),
    license: z.string().max(100),
  }),
  submissions: z
    .array(
      z.object({
        externalId: z.string().min(1).max(200),
        paper: PaperIdentifier,
        number: z.number().int().nullable(),
        status: z.enum(SUBMISSION_STATUSES).nullable(),
        decision: z.string().max(1000).nullable(),
        keywords: z.array(z.string().max(200)).max(100).optional(),
        /** The area its authors chose from the venue's list: OpenReview's `primary_area`. */
        primaryArea: z.string().max(1000).nullish(),
        /** Its one-sentence summary: OpenReview's `TLDR`. */
        tldr: z.string().max(5000).nullish(),
        /** Where it is presented, for a venue held in several places at once: "Sydney". */
        site: z.string().max(200).nullish(),
        submittedAt: z.iso.datetime({ offset: true }).nullish(),
        url: Url,
        notes: z.array(Note).max(MAX_NOTES),
      }),
    )
    .max(MAX_IMPORT_SUBMISSIONS),
});
export const ImportedSubmissions = z.object({
  submissions: z.number().int(),
  notes: z.number().int(),
  skipped: z.number().int(),
  committed: z.number().int(),
  unchanged: z.number().int(),
  failed: z.array(z.object({ externalId: z.string(), error: z.string() })),
});

/** A venue's schedule: when and where each of its submissions is presented, onto the entry its reviews' import made. */
export const ImportPresentationsBody = z.object({
  source: Source,
  submissions: z
    .array(
      z.object({
        externalId: z.string().min(1).max(200),
        url: Url.nullish(),
        /** Where it is presented, for a venue held in several places at once: "Sydney". */
        site: z.string().max(200).nullish(),
        /** Every time it is presented; one left out is removed. */
        presentations: z.array(presentationSchema).max(20),
      }),
    )
    .max(MAX_IMPORT_SUBMISSIONS),
});
export const ImportedPresentations = z.object({
  submissions: z.number().int(),
  skipped: z.number().int(),
  committed: z.number().int(),
  unchanged: z.number().int(),
  failed: z.array(z.object({ externalId: z.string(), error: z.string() })),
});

/** The venues' series and edition pages (`/v/iclr`, `/v/iclr/2027`), made by the `venues` bot if missing. */
export const ImportVenuesBody = z.object({
  venues: z.array(z.object({ id: z.string().min(3).max(300), name: z.string().min(1).max(200) })).max(50),
});
export const ImportedVenues = z.object({ written: z.array(z.string()), skipped: z.array(z.string()) });

export const ImportVersionsBody = z.object({
  paper: PaperIdentifier,
  versions: z.array(z.object({ ...VersionFields, url: Url })).max(20),
  /** Replace the labels of the versions it finds, after a change to how the tool names them. */
  relabel: z.boolean().optional(),
  summary: z.string().max(1000).optional(),
});

export const ImportPdfBody = z.object({
  paper: PaperIdentifier,
  /** `url` as `POST /api/v1/files` answered; `source`, where the bytes came from. */
  pdf: z.object({ url: z.string().max(2000), license: z.string().max(100).nullish(), source: Url.nullish() }),
  /** The version it is the PDF of, by its address or a forum one of its submissions names; made if missing. */
  at: z.object({ url: Url, label: z.string().min(1).max(200) }),
});

/** Links to the paper elsewhere, such as the code its abstract names, added under its title if not there. */
export const ImportLinksBody = z.object({
  paper: PaperIdentifier,
  links: z.array(linkFileSchema).max(MAX_LINKS),
  summary: z.string().max(1000).optional(),
});

export const ImportCommitted = z.object({ head: z.string().nullable(), changed: z.boolean() });

const committed = (result: CommitResult) => ({ head: result.oid, changed: result.status === 'committed' });

async function importer(req: Request) {
  const principal = await requireAuth(req);
  return { principal, ...(await requireImporter(principal)) };
}

export const getImportPapers = route(async (req) => {
  const { principal } = await importer(req);
  const query = parseQuery(req, ImportPapersQuery);
  return respond(ImportPapersList, await importPapers(query), { principal });
});

export const postImportPapers = route(async (req) => {
  const { principal, grants } = await importer(req);
  if (!importsFrom(grants, 'openreview')) {
    throw new ApiError(403, 'forbidden', 'only a bot granted reviews/openreview/** adds papers by OpenReview id');
  }
  const { papers } = await parseBody(req, ImportPapersBody);
  const result = await importSubmissions(papers.map(({ openreview, ...p }) => ({ id: openreview, ...p })));
  return respond(ImportedPapers, result, { principal });
});

export const postImportSubmissions = route(async (req) => {
  const { principal, grants, actor } = await importer(req);
  const { venue, submissions } = await parseBody(req, ImportSubmissionsBody);
  if (!importsFrom(grants, venue.source)) {
    throw new ApiError(403, 'forbidden', `this bot is not granted reviews/${venue.source}/**`);
  }
  const result = await importReviews(
    { ...venue, forms: venue.forms as VenueForms },
    submissions.map((s) => ({
      ...s,
      submittedAt: s.submittedAt ? new Date(s.submittedAt) : null,
      notes: s.notes.map((n) => ({
        ...n,
        createdAt: new Date(n.createdAt),
        modifiedAt: n.modifiedAt ? new Date(n.modifiedAt) : null,
      })),
    })),
    { actor, rateLimit: IMPORT_RATE_LIMIT, concurrency: 4 },
  );
  await refreshPageIds(getDb(), result.changed);
  const { changed: _, ...body } = result;
  return respond(ImportedSubmissions, body, { principal });
});

export const postImportVenues = route(async (req) => {
  const { principal, grants } = await importer(req);
  const { venues } = await parseBody(req, ImportVenuesBody);
  for (const venue of venues) {
    const source = venue.id.slice(0, venue.id.indexOf(':'));
    if (!source || !importsFrom(grants, source)) {
      throw new ApiError(403, 'forbidden', `this bot does not import from the source of ${venue.id}`);
    }
  }
  return respond(ImportedVenues, await syncVenuePages({ venues }), { principal });
});

export const postImportVersions = route(async (req) => {
  const { principal, actor } = await importer(req);
  const body = await parseBody(req, ImportVersionsBody);
  const { result, identifiers } = await importVersions(actor, {
    ...body,
    versions: body.versions.map((v) => ({
      ...v,
      date: v.date ?? undefined,
      title: v.title ?? undefined,
      abstract: v.abstract ?? undefined,
      note: v.note ?? undefined,
    })),
  });
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(ImportCommitted, committed(result), { principal });
});

export const postImportPdf = route(async (req) => {
  const { principal, actor } = await importer(req);
  const { result, identifiers } = await importPdf(actor, await parseBody(req, ImportPdfBody));
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(ImportCommitted, committed(result), { principal });
});

export const postImportLinks = route(async (req) => {
  const { principal, actor } = await importer(req);
  const { result, identifiers } = await importLinks(actor, await parseBody(req, ImportLinksBody));
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(ImportCommitted, committed(result), { principal });
});

export const postImportPresentations = route(async (req) => {
  const { principal, grants, actor } = await importer(req);
  const { source, submissions } = await parseBody(req, ImportPresentationsBody);
  if (!importsFrom(grants, source)) {
    throw new ApiError(403, 'forbidden', `this bot is not granted reviews/${source}/**`);
  }
  const result = await importPresentations(source, submissions, { actor });
  await refreshPageIds(getDb(), result.changed);
  const { changed: _, ...body } = result;
  return respond(ImportedPresentations, body, { principal });
});
