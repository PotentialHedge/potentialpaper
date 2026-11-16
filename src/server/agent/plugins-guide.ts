import { KINDS, PAGE_KINDS } from '@/lib/kinds';
import { API_VERSION, PERMISSIONS, PERMISSION_NAMES } from '@/lib/plugins/manifest';
import { SDK_BASE } from '@/lib/plugins/origin';
import { HOST_METHODS, MAX_FRAME_HEIGHT, MAX_STORAGE_BYTES, THEME_TOKENS } from '@/lib/plugins/protocol';
import { MANIFEST_FILE } from '@/lib/plugins/sources';
import { PLUGIN_TOPIC } from '../plugins/discover';
import { MAX_PLUGIN_BYTES, MAX_PLUGIN_FILE_BYTES, MAX_PLUGIN_FILES } from '../plugins/snapshot';

/**
 * `/plugins.md` (`handoffs/plugins.md` Phase 3): how to build, try and publish a PotentialPaper plugin, written for
 * agents (a person's README says "Read https://…/plugins.md and build me a PotentialPaper plugin."). The tables of
 * permissions, RPC methods and `when` keys are made from the code, so they can't drift from what the host does.
 */

/** What each RPC method does, as the SDK calls it. Every method in `HOST_METHODS` has a line (a test checks). */
export const METHOD_DOCS: Record<keyof typeof HOST_METHODS, { call: string; does: string }> = {
  'context.get': {
    call: 'pp.getContext()',
    does: 'The page, its scopes, the viewer, the theme and your settings. Also `pp.ready` and `pp.context`.',
  },
  'settings.get': { call: 'pp.settings.get()', does: 'Your settings, by name, as they resolve for this reader.' },
  'settings.set': {
    call: 'pp.settings.set(name, value)',
    does: "Set one of your own settings in the reader's settings.json.",
  },
  'storage.get': {
    call: 'pp.storage.get([key])',
    does: `Small state per reader and plugin, kept with their account (${MAX_STORAGE_BYTES / 1024} KB).`,
  },
  'storage.set': { call: 'pp.storage.set(key, value)', does: '`null` removes the key.' },
  'page.read': {
    call: 'pp.page.read([identifier])',
    does: "A page's kind file, sections and links: the current page by default.",
  },
  'page.members': {
    call: 'pp.page.members([identifier], { offset, limit, rollUp })',
    does: "A venue's, topic's or organisation's papers, paged, rolled up from the pages under it.",
  },
  'page.resolve': {
    call: 'pp.page.resolve(identifier)',
    does: "Any page's summary, its scopes, and whether it has submissions and scores.",
  },
  'reviews.forPaper': {
    call: 'pp.reviews.forPaper([identifier])',
    does: "A paper's submissions, with their reviews, decisions and the venue's forms.",
  },
  'scope.scores': {
    call: 'pp.scope.scores([identifier], [venue], [field])',
    does: "A scope's score statistics: its venues and fields with counts, or one field's sorted means, bins and split by outcome.",
  },
  'scope.papers': {
    call: 'pp.scope.papers([identifier], { fields, onChunk })',
    does: "Every paper of a scope with its submissions, statuses and each review's scores, in chunks, for your own statistics.",
  },
  'ui.setHeight': {
    call: 'pp.ui.setHeight(px)',
    does: `Size your frame yourself (at most ${MAX_FRAME_HEIGHT}px). By default the SDK sizes it to your body.`,
  },
  'ui.openUrl': { call: 'pp.ui.openUrl(url)', does: 'Open an http(s) address in a new tab.' },
};

export function pluginsGuide(origin: string): string {
  const sdk = `${SDK_BASE}v1/pp.js`;
  const types = `${SDK_BASE}v1/pp.d.ts`;
  const mb = (n: number) => `${n / 1024 / 1024} MB`;
  const permissionRows = PERMISSION_NAMES.map((p) => `| \`${p}\` | ${PERMISSIONS[p]} |`).join('\n');
  const methodRows = (Object.keys(HOST_METHODS) as (keyof typeof HOST_METHODS)[])
    .map(
      (m) =>
        `| \`${METHOD_DOCS[m].call}\` | ${HOST_METHODS[m] ? `\`${HOST_METHODS[m]}\`` : '—'} | ${METHOD_DOCS[m].does} |`,
    )
    .join('\n');
  const kindRows = PAGE_KINDS.map((k) => `| \`${k}\` | \`${KINDS[k].contextKeys.join('`, `')}\` |`).join('\n');

  return `# Building a PotentialPaper plugin

> Read ${origin}/plugins.md and build me a PotentialPaper plugin.

A PotentialPaper plugin adds panels to pages on ${origin}: a paper, a venue, a topic, an organisation or a person.
It is an HTML page plus a manifest, \`${MANIFEST_FILE}\`, in a public GitHub repo. Readers find it under
Settings → Plugins (${origin}/settings/plugins), install it pinned to a commit, and approve what it may read before it
runs. Like a VS Code extension, a plugin never edits the site's own interface: it *declares* what it adds (panels,
pages of its own, settings and commands) and the site draws it. Its code runs in a sandboxed frame on an origin of its
own and reaches the site only through the SDK, \`window.pp\`.

## Build one (for agents)

You were asked to build a plugin. Do it without asking the person anything except what the plugin should do (ask
that if they haven't said). Pick a short slug \`<name>\` for it (\`citation-graph\`, \`score-standing\`).

1. **Make the repo**, with the GitHub CLI:

   \`\`\`sh
   gh repo create potentialpaper-<name> --public --clone --description "<one line>"
   cd potentialpaper-<name>
   gh repo edit --add-topic ${PLUGIN_TOPIC}
   \`\`\`

   The topic is what lists it under Discover on ${origin}/settings/plugins (and in
   \`GET ${origin}/api/v1/plugins/discover\`), so people can find it.

2. **Write the files** (see [Files](#files)): \`${MANIFEST_FILE}\`, \`index.html\` loading the SDK, and your script.
   Plain JavaScript needs no build. If you use a bundler, **commit the built files**: the site never runs a build, it
   copies the files in the repo as they are. Add a \`README.md\` saying what it does and how to install it (step 5).

3. **Try it** against the live site from your machine before releasing: [Develop](#develop).

4. **Release it.** The git tag is the version: \`v\` + \`version\` from the manifest.

   \`\`\`sh
   git add -A && git commit -m "v0.1.0"
   git tag v0.1.0
   git push -u origin HEAD && git push origin v0.1.0
   \`\`\`

5. **Install it** for the person: on ${origin}/settings/plugins under "Add by source" (\`<owner>/potentialpaper-<name>\`),
   or for them with their API key: \`POST ${origin}/api/v1/me/plugins\` with
   \`{ "source": "github:<owner>/potentialpaper-<name>@v0.1.0" }\`. Without a tag, the newest release is installed. It
   runs once they approve its permissions in their browser, on a page it shows on or on /settings/plugins; you can't
   approve it for them.

6. **Ship changes** as new releases: bump \`version\`, commit, tag, push. Readers see "Update" on /settings/plugins
   for a tag newer than the version they run (prereleases such as \`v1.0.0-rc.1\` are never offered). An update that
   asks for a new permission or network origin asks them again before it switches.

The example plugin, \`examples/plugins/hello\` in the site's repo
(https://github.com/PotentialHedge/potentialpaper/tree/main/examples/plugins/hello), is a complete one to start from:
it reads its context and a setting, keeps a count in its storage, reads the page, and offers a command.

## What a plugin is

- **Its id is \`<owner>/<name>\`**, lower-case, and the owner must be the GitHub owner of the repo it comes from, so
  nobody can publish under someone else's id. Settings, storage and approvals are keyed by it.
- **Its source** is \`github:<owner>/<repo>[/<folder>][@<tag, branch or commit>]\` (also \`owner/repo\`, or a GitHub
  link). A plugin in a folder of a larger repo names the folder; its manifest sits at the top of that folder.
- **Pinned to a commit.** Installing resolves the tag to a commit and copies the files at that commit once; the
  plugin then runs that copy, whatever happens to the repo, until the reader updates it.
- **Its own origin.** Every plugin is served from \`plugin-<hash>.<content domain>/<commit>/…\`, an origin no other
  plugin and not the site shares, in a frame sandboxed \`allow-scripts allow-same-origin\`. Its \`localStorage\` and
  IndexedDB are its own and survive updates: use them for caches.
- **Its CSP**: \`default-src 'self'\`, scripts from your own files and the SDK, \`connect-src 'self'\` plus the
  manifest's \`network\` origins, images from \`data:\` and \`blob:\` too, inline styles allowed, \`wasm\` allowed. No
  inline scripts, no CDN scripts: commit what you load.
- **Files**: at most ${MAX_PLUGIN_FILES} files and ${mb(MAX_PLUGIN_BYTES)} in all, ${mb(MAX_PLUGIN_FILE_BYTES)} each, of the usual web
  types (HTML, JS, CSS, JSON, SVG, PNG and other images, WOFF2, WASM, …). Dot-folders, \`node_modules\` and source
  files such as \`.ts\` are left out of the copy.
- **Data is public.** Everything a plugin reads through the RPC is public on the site anyway. Permissions say what a
  plugin takes an interest in, so the reader knows before running it. A plugin never writes state other readers see:
  only the reader's own settings and storage.

## Files

\`\`\`
${MANIFEST_FILE}
index.html
main.js
\`\`\`

\`${MANIFEST_FILE}\` ([schema](${origin}/schemas/plugin-manifest.json)):

\`\`\`json
{
  "$schema": "${origin}/schemas/plugin-manifest.json",
  "id": "<owner>/<name>",
  "name": "Citation graph",
  "version": "0.1.0",
  "apiVersion": ${API_VERSION},
  "description": "One line, shown on /settings/plugins.",
  "author": "you",
  "main": "index.html",
  "permissions": ["page.read"],
  "network": [],
  "contributes": {
    "panels": [
      {
        "id": "graph",
        "title": "Citation graph",
        "kinds": ["paper", "venue"],
        "slot": { "paper": "aside", "*": "main" },
        "when": "page.hasSubmissions"
      }
    ],
    "pages": [{ "id": "about", "title": "About" }],
    "settings": {
      "depth": { "type": "number", "default": 2, "minimum": 1, "maximum": 4, "description": "How many hops to draw." }
    },
    "commands": [{ "id": "export", "title": "Copy as CSV" }]
  }
}
\`\`\`

\`index.html\`:

\`\`\`html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script src="https://ppusercontent.com/sdk/v1/pp.js"></script>
  </head>
  <body>
    <div id="app"></div>
    <script src="main.js"></script>
  </body>
</html>
\`\`\`

\`main.js\`:

\`\`\`js
pp.ready.then(async (ctx) => {
  const app = document.getElementById('app');
  if (!ctx.page) return; // on the plugin's own page
  const files = await pp.page.read();
  app.textContent = \`\${files.links.length} links on \${ctx.page.name}\`;
});
\`\`\`

Every field of the manifest:

- \`id\`, \`name\`, \`version\` (semver; tag releases \`v\` + it), \`apiVersion\` (${API_VERSION}), \`main\` (the HTML file every
  frame loads), and optionally \`description\`, \`author\`, \`homepage\`.
- \`permissions\`: what it may read ([Permissions](#permissions)).
- \`network\`: https origins its own backend lives at (\`https://api.example.org\`), which its frames may connect to.
  They are shown to the reader before they approve it, and a new one needs their approval again.
- \`contributes.panels\` (up to 8): \`id\`, \`title\`, \`kinds\` (${PAGE_KINDS.map((k) => `\`${k}\``).join(', ')}), \`slot\`
  (\`main\`, \`aside\` or \`tab\`; or one per kind, \`{ "paper": "aside", "*": "main" }\`), and \`when\`.
- \`contributes.pages\` (up to 8): whole pages of its own at \`${origin}/x/<owner>/<name>/<page id>/…\`.
- \`contributes.settings\`: each \`{ "type": "boolean" | "number" | "string" | "enum", "default", "description" }\`, with
  \`minimum\`/\`maximum\` for numbers, \`maxLength\` for strings, \`values\` (and \`labels\`) for enums. They appear in the
  reader's settings.json as \`"<plugin id>.<name>"\`, and as a form on /settings/plugins.
- \`contributes.commands\` (up to 16): \`id\` and \`title\`, listed in each of its panels' menus; handle them with
  \`pp.commands.register(id, handler)\`.

Fields the site doesn't know are warnings, not errors, so a newer manifest still loads. Every problem is listed at once
when the plugin is installed or loaded from localhost.

### When a panel shows

A panel's \`when\` decides whether it is on a page at all, so a page doesn't start a frame for every installed
plugin: \`page.hasScores\`, \`page.kind == venue && signedIn\`, \`!viewer.isOwner\`. It has \`&&\`, \`||\`, \`!\`, \`==\`,
\`!=\` and parentheses, over the keys each kind offers:

| Kind | \`when\` keys |
| ---- | ----------- |
${kindRows}

## Permissions

| Permission | What the reader is told |
| ---------- | ----------------------- |
${permissionRows}

Ask only for what you use: each is listed in the approval prompt, and a call without its permission fails with
\`PermissionDenied\`.

## The SDK

Load \`https://ppusercontent.com/sdk/v1/pp.js\` (here: ${sdk}); it installs \`window.pp\`. Its types are
[pp.d.ts](${types}): copy it next to your code. Calls made before the page has answered wait for it. Errors are
\`PluginError\`s with a \`code\` (\`MethodNotFound\`, \`PermissionDenied\`, \`InvalidParams\`, \`Unavailable\`, \`Internal\`).

| Call | Needs | Does |
| ---- | ----- | ---- |
${methodRows}

Events: \`pp.on('settings.change' | 'theme.change' | 'context.change', listener)\`, or \`pp.settings.onChange\` and
\`pp.theme.onChange\`. \`pp.supports(method)\` says whether this site answers a method, and \`pp.call(method, params)\`
calls one newer than your copy of the types.

**Theme.** The SDK sets the page's design tokens on your \`:root\` as CSS variables, on load and whenever the reader
switches between light and dark: ${THEME_TOKENS.map((t) => `\`--pp-${t}\``).join(', ')}. Use them
(\`color: var(--pp-ink); background: var(--pp-bg)\`) and your panel matches the page.

**Size.** The SDK sizes your frame to your \`body\`; make the page work at phone width. Frames start when they come
within 200px of the screen.

**Identifiers.** Pages are named by identifier: \`arxiv:1706.03762\`, \`doi:…\`, \`venue:iclr/2027\`, \`topic:<slug>\`,
\`org:<slug>\`, \`user:<handle>\`. \`pp.context.page.identifier\` is the current one, and \`pp.context.scopes\` the pages
above it (a paper's venues, topics and organisations).

## Data routes

The same data is public over HTTP, for a plugin's own backend or a script. Identifiers are URL-encoded as one path
segment (\`venue%3Aiclr%2F2027\`). Each answer is cached a minute.

- \`GET ${origin}/api/v1/pages/<identifier>\`: a page's summary, its scopes and facts (\`page.resolve\`)
- \`GET ${origin}/api/v1/pages/<identifier>/files\`: its kind file, sections and links (\`page.read\`)
- \`GET ${origin}/api/v1/pages/<identifier>/members?offset=&limit=&rollUp=\`: a scope's papers (\`page.members\`)
- \`GET ${origin}/api/v1/pages/<identifier>/submissions\`: a paper's submissions and reviews (\`reviews.forPaper\`)
- \`GET ${origin}/api/v1/pages/<identifier>/venue-papers?status=&decision=&q=\`: a venue's submissions by status
- \`GET ${origin}/api/v1/pages/<identifier>/scores\`: a scope's score statistics, the venues and score fields with
  counts (\`scope.scores\`)
- \`GET ${origin}/api/v1/pages/<identifier>/scores/<venue>/<field>\`: one field at one venue (the venue's id,
  \`openreview:ICLR.cc/2027/Conference\`, URL-encoded): every submission's mean over its reviews, sorted, fixed-width
  bins, and the same split by outcome (\`accepted\`, \`rejected\`, \`withdrawn\`, \`pending\`)
- \`GET ${origin}/api/v1/pages/<identifier>/papers?fields=submissions,scores,status&limit=&after=\`: a scope's papers
  as NDJSON, one a line, with every submission, its status and each review's score vector (\`scope.papers\`). Without
  \`limit\`, all of them in one stream; with it, one chunk and the next cursor in \`X-Next-Cursor\`. Gzipped when asked.

The score and paper routes send an \`ETag\` and answer \`If-None-Match\` with a 304: cache what you fetch (in your
origin's IndexedDB) and ask again with the tag. Statistics are recomputed a few seconds after a change; curve-fitting
and percentiles are yours to do from \`values\`. A site may withhold a venue's statistics until its decisions are out
(\`hidden: true\`, with no values). Reviews are CC BY 4.0: show each one's licence and link with what you draw from
it. The OpenAPI description of these routes is at ${origin}/openapi.json.

A plugin with its own backend lists that backend's origin in \`network\`; it never gets the reader's session.

## Develop

Serve the plugin's folder from your machine with CORS on, and load it into the site in your own browser:

\`\`\`sh
npx http-server . -p 5174 --cors
\`\`\`

then on ${origin}/settings/plugins, under "Load from localhost", enter \`http://localhost:5174/\`. A plugin loaded this
way runs in that browser only, unpinned (reload the page to see a change), with what it asks for and no approval. It
stands in for an installed plugin with the same id. Its manifest is checked with the same validator as on install,
and problems are listed there. Against a site running locally (\`npm run dev\` in the site's repo), the same works at
\`http://localhost:3000/settings/plugins\`.

## Publish

- Tag a release (\`v\` + the manifest's \`version\`) and push the tag: that is what readers install and are offered.
- Add the topic \`${PLUGIN_TOPIC}\` to the repo (\`gh repo edit --add-topic ${PLUGIN_TOPIC}\`). Discover lists the topic's
  public, unarchived repos, most starred first, refreshed every five minutes.
- Keep \`dist/\` (or whatever \`main\` loads) committed and current: the site serves the files in the repo at the tag.
- A site admin can block a plugin, or one commit of it, for everyone (\`plugins.blocked\`), or install one for
  everyone (\`plugins.default\`).
`;
}
