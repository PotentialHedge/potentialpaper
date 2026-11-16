/**
 * settings.json (DESIGN.md §10): one document per account, layered as in VS Code, defaults ← site ← user. Shared by
 * the server and the browser. `core.ts` declares the site's settings, `spec.ts` how a plugin declares its own,
 * `document.ts` reads, checks, resolves and edits the text, and `schema.ts` makes its JSON Schema.
 */
export * from './core';
export * from './document';
export * from './schema';
export * from './spec';
