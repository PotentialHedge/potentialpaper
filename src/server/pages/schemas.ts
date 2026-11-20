import { z } from 'zod';
import {
  ALL_PARTS,
  KINDS,
  orgFileSchema,
  PAGE_KINDS,
  type PageKind,
  profileFileSchema,
  topicFileSchema,
  venueFileSchema,
} from '@/lib/kinds';
import { labeledLinkSchema, LINK_LABELS } from '@/lib/labeled-links';
import { linkFileSchema } from '@/lib/paper-links';
import { authorPluginsFileSchema } from '@/lib/plugins/author-plugins';
import { formsFileSchema, noteFileSchema, submissionFileSchema } from '@/lib/review-files';
import { scoreOf } from '@/lib/submissions';
import { versionFileSchema } from '@/lib/versions';
import { leadingHtmlTitle } from './html';
import { leadingTitle } from './markdown';
import { pdfSourceSchema, sectionName, thumbnailWordsSchema } from './rules';

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
 *   extensions come later (§10), and plug in by the same pattern;
 * - **the kinds of page** it may be on (`lib/kinds.ts`, `handoffs/pages.md`): every kind's `fileTypes` name the
 *   types it allows, and a type lists those kinds back (`kinds`), which `kindsOfFileType` reads.
 *
 * What JSON Schema can't say (that a label isn't blank, an address parses) only the site checks.
 *
 * Most types are JSON. A `text` type (sections) is checked by its own rules in `rules.ts` and has no JSON Schema;
 * its "schema" only takes the file's text as it is, so its indexer sees the same thing a JSON type's does.
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

/**
 * Where a search looks (`lib/query.ts`'s `in:`): `page` is what people write on it (sections, links, versions, the
 * picture's words), `reviews` what a bot imported under `reviews/<source>/`. Titles and abstracts are `paper`,
 * searched through `papers.search`, not files.
 */
export type SearchScope = 'page' | 'reviews';

/** Where on a page a type is shown: one of its kind's slots (`lib/kinds.ts`), as `paper.main` or `venue.aside`. */
export type RenderSlot = string;

export interface FileType<S extends z.ZodType = z.ZodType> {
  title: string;
  schema: S;
  /** For editors' `jsonValidation`, from the repo's root. */
  glob: string;
  /** The same pattern as a regex over the path, for `prek.toml` (Python's `re`) and `fileTypeOf`. */
  filesRegex: string;
  /** Whether people write it, and so `prek.toml` checks it before a commit (JSON types only). */
  writable: boolean;
  /**
   * `json` (the default): parsed, then checked against `schema`, which is served as JSON Schema. `jsonl`: one JSON
   * value a line, each checked against `schema` (a line's). `text`: as it is.
   */
  format?: 'json' | 'jsonl' | 'text';
  /** Which `in:` scope its search documents belong to; every type with `index` has one. */
  scope?: SearchScope;
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

/**
 * A section's words without most of its markup, for search and its snippets: tags and entities of an HTML
 * section, and in Markdown the link targets, images' addresses, heading marks and emphasis. Math and code stay.
 */
export function sectionText(text: string, html: boolean): string {
  if (html) {
    return text
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|\*|~~)(?=\S)([^]*?\S)\1/g, '$2')
    .trim();
}

/** The part a section file belongs to, from its path (which the registry's pattern already matched). */
function partOf(path: string): string {
  return path.slice(0, path.indexOf('/'));
}

const PARTS_GLOB = `{${ALL_PARTS.join(',')}}`;
const PARTS_RE = `(${ALL_PARTS.join('|')})`;

/** A kind file's type: at the top of the repo, written by people (and on venues and orgs, a bot). */
function kindFileType<S extends z.ZodType>(kind: PageKind, schema: S): FileType<S> {
  const file = KINDS[kind].kindFile;
  return {
    title: KINDS[kind].title,
    schema,
    glob: file,
    filesRegex: `^${file.replace('.', '\\.')}$`,
    writable: true,
    scope: 'page',
    index: (value) => {
      const record = value as { name?: unknown; aliases?: unknown };
      const name = typeof record.name === 'string' ? record.name : null;
      const aliases = Array.isArray(record.aliases) ? record.aliases.filter((a) => typeof a === 'string') : [];
      return name ? [{ kind, text: words(name, ...aliases), fields: { name } }] : [];
    },
    render: { panel: 'Header', slots: [`${kind}.main`] },
  };
}

export const PAGE_SCHEMAS = {
  section: fileType({
    title: 'Section',
    schema: z.string(),
    glob: `${PARTS_GLOB}/[0-9][0-9]-*.{md,html}`,
    filesRegex: `^${PARTS_RE}/\\d{2}-[a-z0-9]+(-[a-z0-9]+)*\\.(md|html)$`,
    writable: true,
    format: 'text',
    scope: 'page',
    index: (text, path) => {
      const part = partOf(path);
      const name = sectionName(path, part);
      // A blank file is a section nobody has written yet (`starter.ts`); it isn't shown, so it isn't found.
      if (!name || text.trim() === '') return [];
      const html = name.format === 'html';
      const title = (html ? leadingHtmlTitle(text) : leadingTitle(text)) || null;
      return [{ kind: 'section', text: sectionText(text, html), fields: { part, title } }];
    },
    render: { panel: 'Sections', slots: PAGE_KINDS.map((kind) => `${kind}.main`) },
  }),
  labeledLink: fileType({
    title: 'Labeled links',
    scope: 'page',
    schema: labeledLinkSchema,
    glob: `${PARTS_GLOB}/links.jsonl`,
    filesRegex: `^${PARTS_RE}/links\\.jsonl$`,
    writable: true,
    format: 'jsonl',
    index: (link) => [
      {
        kind: 'labeled-link',
        text: words(LINK_LABELS[link.label].reads, link.to, link.note, link.from_anchor, link.to_anchor),
        fields: { label: link.label, to: link.to },
      },
    ],
    render: { panel: 'Links', slots: PAGE_KINDS.map((kind) => `${kind}.aside`) },
  }),
  authorPlugins: fileType({
    title: 'Author section plugins',
    schema: authorPluginsFileSchema,
    glob: 'owners/plugins.json',
    filesRegex: '^owners/plugins\\.json$',
    writable: true,
    render: { panel: 'AuthorSection', slots: ['paper.author'] },
  }),
  venue: fileType(kindFileType('venue', venueFileSchema)),
  topic: fileType(kindFileType('topic', topicFileSchema)),
  org: fileType(kindFileType('org', orgFileSchema)),
  profile: fileType({ ...kindFileType('user', profileFileSchema), index: undefined }),
  link: fileType({
    title: 'Link',
    scope: 'page',
    schema: linkFileSchema,
    glob: 'links/*.json',
    filesRegex: '^links/[^/]+\\.json$',
    writable: true,
    index: (link) => [{ kind: 'link', text: words(link.label, link.url), fields: { label: link.label.trim() } }],
    render: { panel: 'TitleActions', slots: ['paper.title'] },
  }),
  version: fileType({
    title: 'Version',
    scope: 'page',
    schema: versionFileSchema,
    glob: 'versions/*.json',
    filesRegex: '^versions/[^/]+\\.json$',
    writable: true,
    index: (version) => [
      {
        kind: 'version',
        text: words(version.label, version.title, version.decision, version.note, version.abstract),
        fields: {
          label: version.label,
          kind: version.kind,
          status: version.status ?? null,
          date: version.date ?? null,
        },
      },
    ],
    render: { panel: 'Versions', slots: ['paper.aside', 'paper.body'] },
  }),
  thumbnail: fileType({
    title: 'Picture',
    scope: 'page',
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
    scope: 'reviews',
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
    scope: 'reviews',
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

export type FileTypeName = keyof typeof PAGE_SCHEMAS;

/**
 * The JSON types: those with a JSON Schema, served at `/schemas/<name>.json` and checked by editors and `prek`. A
 * `jsonl` type's schema is its line's, so `prek` (which checks whole files) leaves it to the site (`starter.ts`).
 */
export type PageSchemaName = {
  [K in FileTypeName]: (typeof PAGE_SCHEMAS)[K] extends { format: 'text' } ? never : K;
}[FileTypeName];

export const PAGE_SCHEMA_NAMES = (Object.keys(PAGE_SCHEMAS) as FileTypeName[]).filter(
  (name): name is PageSchemaName => (PAGE_SCHEMAS[name] as FileType).format !== 'text',
);

export function isPageSchemaName(name: string): name is PageSchemaName {
  return (PAGE_SCHEMA_NAMES as readonly string[]).includes(name);
}

const PATTERNS = (Object.keys(PAGE_SCHEMAS) as FileTypeName[]).map(
  (name) => [name, new RegExp(PAGE_SCHEMAS[name].filesRegex)] as const,
);

/** The registered type of the file at this path, or `null`. */
export function fileTypeOf(path: string): FileTypeName | null {
  return PATTERNS.find(([, pattern]) => pattern.test(path))?.[0] ?? null;
}

/** The kinds of page a file type may be on: those whose `fileTypes` name it (`lib/kinds.ts`). */
export function kindsOfFileType(name: FileTypeName): PageKind[] {
  return PAGE_KINDS.filter((kind) => KINDS[kind].fileTypes.includes(name));
}

/** The `in:` scope of the file at this path's search documents, or `null` if it isn't searched. */
export function searchScopeOf(path: string): SearchScope | null {
  const name = fileTypeOf(path);
  return name ? ((PAGE_SCHEMAS[name] as FileType).scope ?? null) : null;
}

/**
 * The search documents for a file: `null` if its path has no registered type or it doesn't parse as one (the
 * commit path refuses such files, so only old commits can have them), `[]` if its type isn't searched.
 */
export function indexFile(path: string, text: string): IndexedDoc[] | null {
  const name = fileTypeOf(path);
  if (!name) return null;
  const type: FileType = PAGE_SCHEMAS[name];
  if (type.format === 'jsonl') {
    const docs: IndexedDoc[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return null;
      }
      const parsed = type.schema.safeParse(value);
      if (!parsed.success) return null;
      docs.push(...(type.index ? type.index(parsed.data, path) : []));
    }
    return docs;
  }
  let value: unknown = text;
  if (type.format !== 'text') {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
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
