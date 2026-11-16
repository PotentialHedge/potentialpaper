import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_SCHEMA_NAMES, PAGE_SCHEMAS, pageJsonSchema } from '@/server/pages/schemas';

/**
 * Writes the page repos' JSON Schemas (`src/server/pages/schemas.ts`) into a folder, with the web editor
 * extension's `jsonValidation` for them, and VS Code's skeletons for a new file: `scripts/build-editor-extension.mjs` puts both in the extension, as VS
 * Code's JSON support only reads schema associations an extension contributes or a user sets.
 *
 *   tsx scripts/write-page-schemas.ts <dir>
 */
const dir = process.argv[2];
if (!dir) throw new Error('usage: write-page-schemas.ts <dir>');
mkdirSync(join(dir, 'schemas'), { recursive: true });

type Property = { type?: string; enum?: unknown[]; const?: unknown };

/**
 * VS Code's skeleton for an empty file (`defaultSnippets`, offered by completion): the required fields, with a tab
 * stop each, a choice where the schema lists the values. Not part of the schema the site serves.
 */
function defaultSnippets(schema: Record<string, unknown>, title: string) {
  const properties = (schema.properties ?? {}) as Record<string, Property>;
  const required = (schema.required as string[] | undefined) ?? Object.keys(properties).slice(0, 1);
  const body: Record<string, unknown> = {};
  required.forEach((key, i) => {
    const p = properties[key] ?? {};
    // A file's own shape (`"schema": "review/1"`) is the one value it can have.
    if (p.const !== undefined) body[key] = p.const;
    else if (p.type === 'object') body[key] = {};
    else if (p.enum?.every((v) => typeof v === 'string')) body[key] = `\${${i + 1}|${p.enum.join(',')}|}`;
    else if (p.type === 'number' || p.type === 'integer') body[key] = `^\${${i + 1}:0}`;
    else if (p.type === 'boolean') body[key] = `^\${${i + 1}|false,true|}`;
    else body[key] = `\${${i + 1}}`;
  });
  return [{ label: `New ${title.toLowerCase()}`, description: `The fields a ${title.toLowerCase()} needs`, body }];
}

const jsonValidation = [];
for (const name of PAGE_SCHEMA_NAMES) {
  const schema = pageJsonSchema(name);
  const forEditor = { ...schema, defaultSnippets: defaultSnippets(schema, PAGE_SCHEMAS[name].title) };
  writeFileSync(join(dir, 'schemas', `${name}.json`), `${JSON.stringify(forEditor, null, 2)}\n`);
  jsonValidation.push({ fileMatch: `/${PAGE_SCHEMAS[name].glob}`, url: `./schemas/${name}.json` });
}
writeFileSync(join(dir, 'jsonValidation.json'), `${JSON.stringify(jsonValidation, null, 2)}\n`);
