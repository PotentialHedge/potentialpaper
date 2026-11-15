import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_SCHEMAS, pageJsonSchema, type PageSchemaName } from '@/server/pages/schemas';

/**
 * Writes the page repos' JSON Schemas (`src/server/pages/schemas.ts`) into a folder, with the web editor
 * extension's `jsonValidation` for them: `scripts/build-editor-extension.mjs` puts both in the extension, as VS
 * Code's JSON support only reads schema associations an extension contributes or a user sets.
 *
 *   tsx scripts/write-page-schemas.ts <dir>
 */
const dir = process.argv[2];
if (!dir) throw new Error('usage: write-page-schemas.ts <dir>');
mkdirSync(join(dir, 'schemas'), { recursive: true });
const jsonValidation = [];
for (const name of Object.keys(PAGE_SCHEMAS) as PageSchemaName[]) {
  writeFileSync(join(dir, 'schemas', `${name}.json`), `${JSON.stringify(pageJsonSchema(name), null, 2)}\n`);
  jsonValidation.push({ fileMatch: `/${PAGE_SCHEMAS[name].glob}`, url: `./schemas/${name}.json` });
}
writeFileSync(join(dir, 'jsonValidation.json'), `${JSON.stringify(jsonValidation, null, 2)}\n`);
