import { z } from 'zod';
import { linkFileSchema } from '@/lib/paper-links';
import { versionFileSchema } from '@/lib/versions';
import { pdfSourceSchema, thumbnailWordsSchema } from './rules';

/**
 * The JSON files of a page repo, each with the schema that checks it. One definition each, in zod: the commit
 * path checks files with it (`rules.ts`), and the JSON Schema made from it is served at `/schemas/<name>.json`,
 * which the web editor checks and completes with as people type and `prek.toml` checks with before a commit.
 * What JSON Schema can't say (that a label isn't blank, an address parses) only the site checks.
 */
export const PAGE_SCHEMAS = {
  link: {
    title: 'Link',
    schema: linkFileSchema,
    glob: 'links/*.json',
    filesRegex: '^links/[^/]+\\.json$',
    writable: true,
  },
  version: {
    title: 'Version',
    schema: versionFileSchema,
    glob: 'versions/*.json',
    filesRegex: '^versions/[^/]+\\.json$',
    writable: true,
  },
  thumbnail: {
    title: 'Picture',
    schema: thumbnailWordsSchema,
    glob: 'thumbnail.json',
    filesRegex: '^thumbnail\\.json$',
    writable: true,
  },
  pdf: {
    title: 'Paper PDF',
    schema: pdfSourceSchema,
    glob: '.potentialpaper/pdf.json',
    filesRegex: '^\\.potentialpaper/pdf\\.json$',
    writable: false,
  },
} as const;

export type PageSchemaName = keyof typeof PAGE_SCHEMAS;

export function isPageSchemaName(name: string): name is PageSchemaName {
  return Object.hasOwn(PAGE_SCHEMAS, name);
}

/** The JSON Schema for a kind of file, with its address on the site as its id when there is one. */
export function pageJsonSchema(name: PageSchemaName, origin?: string): Record<string, unknown> {
  return {
    ...z.toJSONSchema(PAGE_SCHEMAS[name].schema, { io: 'input', unrepresentable: 'any' }),
    ...(origin ? { $id: `${origin}/schemas/${name}.json` } : {}),
  };
}
