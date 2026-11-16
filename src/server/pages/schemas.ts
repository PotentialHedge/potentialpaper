import { z } from 'zod';
import { linkFileSchema } from '@/lib/paper-links';
import { formsFileSchema, noteFileSchema, submissionFileSchema } from '@/lib/review-files';
import { scoreOf } from '@/lib/submissions';
import { versionFileSchema } from '@/lib/versions';
import { pdfSourceSchema, thumbnailWordsSchema } from './rules';

/**
 * The file types of a page repo (DESIGN.md §4.8): the contract between whoever writes a file (people, bots) and
 * whatever shows or finds it. Each JSON type is registered once, here, with
 *
 * - **a path pattern** (`glob` for editors, `filesRegex` for `prek.toml` and `fileTypeOf`);
 * - **a schema**, in zod: the commit path checks files with it (`rules.ts`), and the JSON Schema made from it is
 *   served at `/schemas/<name>.json`, which the web editor and desktop extension check and complete with as people
 *   type, `prek.toml` checks with before a commit, and an outside bot's author can validate against. A type that
 *   can change shape names its version inside the file (`"schema": "review/1"`), and a new version is a new entry;
 * - **an indexer**, which turns a file into search documents (§4.10; the search consumer stores them);
 * - **a renderer**: which built-in panel shows files of the type, and in which of the page's slots. Renderers from
 *   extensions come later (§10), and plug in by the same pattern.
 *
 * What JSON Schema can't say (that a label isn't blank, an address parses) only the site checks.
 */

/** A search document made from a file (DESIGN.md §4.10). */
export interface IndexedDoc {
  /** What it is, as search scopes name it: `link`, `version`, `picture`, `submission`, `note`. */
  kind: string;
  /** The words to find it by. */
  text: string;
  /** Values to filter on, such as a review's scores. */
  fields?: Record<string, string | number | boolean | null>;
}

/** Where on the paper's page a type is shown: the slots of `components/paper/slots.tsx`, and the title's links. */
export type RenderSlot = 'paper.title' | 'paper.main' | 'paper.aside' | 'paper.body';

export interface FileType<S extends z.ZodType = z.ZodType> {
  title: string;
  schema: S;
  /** For editors' `jsonValidation`, from the repo's root. */
  glob: string;
  /** The same pattern as a regex over the path, for `prek.toml` (Python's `re`) and `fileTypeOf`. */
  filesRegex: string;
  /** Whether people write it, and so `prek.toml` checks it before a commit. */
  writable: boolean;
  /** The search documents for a valid file. None: it isn't searched. */
  index?: (file: z.output<S>, path: string) => IndexedDoc[];
  /** The built-in panel that shows it. */
  render?: { panel: string; slots: readonly RenderSlot[] };
}

/** Keeps each entry's indexer typed by its own schema. */
function fileType<S extends z.ZodType>(type: FileType<S>): FileType<S> {
  return type;
}

const words = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join('\n');

export const PAGE_SCHEMAS = {
  link: fileType({
    title: 'Link',
    schema: linkFileSchema,
    glob: 'links/*.json',
    filesRegex: '^links/[^/]+\\.json$',
    writable: true,
    index: (link) => [{ kind: 'link', text: words(link.label, link.url), fields: { label: link.label.trim() } }],
    render: { panel: 'TitleActions', slots: ['paper.title'] },
  }),
  version: fileType({
    title: 'Version',
    schema: versionFileSchema,
    glob: 'versions/*.json',
    filesRegex: '^versions/[^/]+\\.json$',
    writable: true,
    index: (version) => [
      {
        kind: 'version',
        text: words(version.label, version.title, version.decision, version.note, version.abstract),
        fields: { kind: version.kind, status: version.status ?? null, date: version.date ?? null },
      },
    ],
    render: { panel: 'Versions', slots: ['paper.aside', 'paper.body'] },
  }),
  thumbnail: fileType({
    title: 'Picture',
    schema: thumbnailWordsSchema,
    glob: 'thumbnail.json',
    filesRegex: '^thumbnail\\.json$',
    writable: true,
    index: (picture) =>
      picture.alt || picture.caption ? [{ kind: 'picture', text: words(picture.alt, picture.caption) }] : [],
    render: { panel: 'ReadThePaper', slots: ['paper.aside'] },
  }),
  pdf: fileType({
    title: 'Paper PDF',
    schema: pdfSourceSchema,
    glob: '.potentialpaper/pdf.json',
    filesRegex: '^\\.potentialpaper/pdf\\.json$',
    writable: false,
    render: { panel: 'ReadThePaper', slots: ['paper.aside'] },
  }),
  submission: fileType({
    title: 'Submission',
    schema: submissionFileSchema,
    glob: 'reviews/*/*/submission.json',
    filesRegex: '^reviews/[^/]+/[^/]+/submission\\.json$',
    writable: false,
    index: (submission) => [
      {
        kind: 'submission',
        text: words(submission.venue.name, submission.decision),
        fields: { venue: submission.venue.id, status: submission.status, number: submission.number },
      },
    ],
    render: { panel: 'Submissions', slots: ['paper.aside', 'paper.body'] },
  }),
  forms: fileType({
    title: 'Venue forms',
    schema: formsFileSchema,
    glob: 'reviews/*/*/forms.json',
    filesRegex: '^reviews/[^/]+/[^/]+/forms\\.json$',
    writable: false,
    // Read with the notes it describes; nothing in it to find on its own.
    render: { panel: 'Submissions', slots: ['paper.body'] },
  }),
  note: fileType({
    title: 'Review',
    schema: noteFileSchema,
    glob: 'reviews/*/*/notes/*.json',
    filesRegex: '^reviews/[^/]+/[^/]+/notes/[^/]+\\.json$',
    writable: false,
    index: (note) => {
      const fields: Record<string, string | number | null> = {
        noteKind: note.kind,
        invitation: note.invitation,
        signature: note.signature,
      };
      const text: string[] = [note.signature];
      for (const [key, value] of Object.entries(note.content)) {
        if (typeof value === 'string') text.push(value);
        else if (Array.isArray(value)) text.push(value.join(', '));
        const score = scoreOf(value);
        // A score is filterable by its form's key (`rating>=8`, later); its words are found like any text.
        if (score !== null && !(key in fields)) fields[key] = score;
      }
      return [{ kind: 'note', text: words(...text), fields }];
    },
    render: { panel: 'Submissions', slots: ['paper.body'] },
  }),
} as const satisfies Record<string, FileType>;

export type PageSchemaName = keyof typeof PAGE_SCHEMAS;

export function isPageSchemaName(name: string): name is PageSchemaName {
  return Object.hasOwn(PAGE_SCHEMAS, name);
}

const PATTERNS = (Object.keys(PAGE_SCHEMAS) as PageSchemaName[]).map(
  (name) => [name, new RegExp(PAGE_SCHEMAS[name].filesRegex)] as const,
);

/** The registered type of the file at this path, or `null`. */
export function fileTypeOf(path: string): PageSchemaName | null {
  return PATTERNS.find(([, pattern]) => pattern.test(path))?.[0] ?? null;
}

/**
 * The search documents for a file: `null` if its path has no registered type or it doesn't parse as one (the
 * commit path refuses such files, so only old commits can have them), `[]` if its type isn't searched.
 */
export function indexFile(path: string, text: string): IndexedDoc[] | null {
  const name = fileTypeOf(path);
  if (!name) return null;
  const type: FileType = PAGE_SCHEMAS[name];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = type.schema.safeParse(value);
  if (!parsed.success) return null;
  return type.index ? type.index(parsed.data, path) : [];
}

/** The JSON Schema for a kind of file, with its address on the site as its id when there is one. */
export function pageJsonSchema(name: PageSchemaName, origin?: string): Record<string, unknown> {
  return {
    ...z.toJSONSchema(PAGE_SCHEMAS[name].schema, { io: 'input', unrepresentable: 'any' }),
    ...(origin ? { $id: `${origin}/schemas/${name}.json` } : {}),
  };
}
