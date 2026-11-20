import { KINDS, PAGE_KINDS } from '@/lib/kinds';
import { API_VERSION, PERMISSIONS, PERMISSION_NAMES } from '@/lib/plugins/manifest';
import { SDK_BASE } from '@/lib/plugins/origin';
import { HOST_METHODS, MAX_FRAME_HEIGHT, MAX_STORAGE_BYTES, THEME_TOKENS } from '@/lib/plugins/protocol';
import { MANIFEST_FILE } from '@/lib/plugins/sources';
import { PLUGIN_TOPIC } from '../plugins/discover';
import { IDENTITY_TOKEN_SECONDS, JWKS_PATH } from '../plugins/identity';
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
    call: 'pp.scope.scores([identifier], [venue], [field], { marks })',
    does: "A scope's score statistics: its venues and fields with counts (each venue with its own page), or one field's sorted means, bins and split by outcome; `marks` adds the scope's own submissions by name.",
  },
  'scope.papers': {
    call: 'pp.scope.papers([identifier], { fields, onChunk })',
    does: "Every paper of a scope with its submissions, statuses and each review's scores, in chunks, for your own statistics.",
  },
  'identity.token': {
    call: 'pp.identity.token()',
    does: 'A short-lived token naming the signed-in reader to your own backend ([Your own backend](#your-own-backend)). `pp.identity.fetch(url, init)` sends it as `Authorization: Bearer …`.',
  },
  'signals.sets': { call: "pp.call('signals.sets')", does: 'Every signal set: its id, name and publisher.' },
  'signals.set': {
    call: 'pp.signals.set(set)',
    does: 'A signal set ([Signals](#signals)): its signals, their kinds and how many papers each covers.',
  },
  'signals.columns': {
    call: 'pp.signals.columns(set, { signals, scope, titles })',
    does: "Some of a set's signals for every paper that has one, by column: a map's whole input in one call.",
  },
  'signals.nearest': {
    call: 'pp.signals.nearest(set, signal, [paper], { k })',
    does: "The papers nearest one paper by a set's vector signal, best first.",
  },
  'signals.forPaper': {
    call: 'pp.signals.forPaper([paper], [set])',
    does: "One paper's values, by set: the current paper by default.",
  },
  'ui.setHeight': {
    call: 'pp.ui.setHeight(px)',
    does: `Size your frame yourself (at most ${MAX_FRAME_HEIGHT}px). By default the SDK sizes it to your body.`,
  },
  'ui.setPath': {
    call: 'pp.ui.setPath(path)',
    does: "On your own page, the rest of its address after the page's id (`surface.path`), replaced in the address bar without a reload, so a view can be shared.",
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
        "slot": { "paper": "submission", "*": "main" },
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
  They are shown to the reader before they approve it, and a new one needs their approval again
  ([Your own backend](#your-own-backend)).
- \`bot\`: the handle of the bot account whose files on pages the plugin shows (\`"bot": "openreview"\`). The approval
  prompt says the plugin shows that bot's data, and what this site lets the bot write; naming a bot grants nothing.
- \`contributes.panels\` (up to 8): \`id\`, \`title\`, \`kinds\` (${PAGE_KINDS.map((k) => `\`${k}\``).join(', ')}), \`slot\`,
  \`movable\` and \`when\`. \`slot\` is the place it prefers: \`main\`, \`aside\` or \`tab\`, and on a paper \`body\` (below
  both columns), \`submission\` (once under each of its submissions with scores, in the Submissions section, with
  \`pp.context.surface.submission.venue\` saying which), \`community\` (at the end of the Community section) or
  \`author\` (see [The author section](#the-author-section)); one for every kind, or one per kind,
  \`{ "paper": "submission", "*": "main" }\`. Readers may move a panel to any other place in their settings
  (\`<kind>.panels.placement\`) unless it says \`"movable": false\`; none can be moved into or out of the author
  section. \`pp.context.surface.place\` says where it is.
- \`contributes.pages\` (up to 8): whole pages of its own at \`${origin}/x/<owner>/<name>/<page id>/…\`, each
  \`{ "id", "title", "layout", "nav" }\`. \`layout\` \`"article"\` (the default) puts the frame under a heading in the site's
  column, as tall as it asks; \`"full"\` gives it the whole window under the site's bar, with no heading, for a map
  or a canvas: the frame is the window's size, so size to it (\`100vh\`) and leave \`ui.setHeight\` out. \`nav\`
  offers a link to the page in the site's navbar: \`true\` names it by its title, a string is the link's own text
  (\`"map"\`). Readers move or hide it in settings, as \`<owner>/<name>.<page id>\` in \`navbar.order\` and
  \`navbar.hidden\`.
- \`contributes.settings\`: each by its name (letters, digits, \`-\`, \`_\`; no dots), \`{ "type", "default" }\` plus
  any of \`title\` (its label; the name spaced out when absent: \`showLegend\` is "Show legend"), \`description\`,
  \`group\` (a heading on your settings page) and \`order\` (lower first, then as listed). Each type is drawn with its
  own control, as VS Code draws its settings:

  | \`type\` | Value | Control | Also |
  | --- | --- | --- | --- |
  | \`boolean\` | \`true\`/\`false\` | a switch | |
  | \`number\` | a number, or \`null\` when the default is | a number field | \`minimum\`, \`maximum\` |
  | \`string\` | text | a text field | \`maxLength\` (up to 1000), \`multiline\`, \`placeholder\` |
  | \`enum\` | one of \`values\` | a dropdown, or radio buttons with \`"display": "radio"\` | \`values\`, \`labels\` |
  | \`list\` | an ordered list of different strings | a list to add to, remove from and reorder | \`values\` (and \`labels\`) to pick from instead of typing, \`maxItems\` (up to 100), \`maxLength\` (each, up to 200), \`placeholder\` |
  | \`set\` | any of \`values\` | a box to tick per value | \`values\`, \`labels\` |

  They appear in the reader's settings.json as \`"<plugin id>.<name>"\`, and on your plugin's own page of the
  settings, ${origin}/settings/plugins/<owner>/<name>, which also lists them in the settings' search.
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

Events: \`pp.on('settings.change' | 'theme.change' | 'context.change' | 'surface.resize', listener)\`, or
\`pp.settings.onChange\`, \`pp.theme.onChange\` and \`pp.ui.onResize\`.

**Where you are, and how big.** \`pp.context.surface.place\` is where a panel sits (\`main\`, \`aside\`, \`tab\`, \`body\`,
\`submission\`, \`community\`, \`author\`), so one panel can draw a small view in the side column and a large one in
the main text. \`pp.context.surface.size\` is the frame's \`{ width, height }\` in CSS pixels, kept current;
\`pp.ui.onResize(size => …)\` tells you when it changes (the column, the window, or your own height). Lay out by the
width: the height is the one you ask for.

**The author section.** A paper's confirmed authors may let panels into their section with \`owners/plugins.json\`
in the paper's repo: \`{ "panels": [{ "panel": "<plugin id>.<panel id>", "settings": { … } }] }\` (up to 8). A
panel shows there only if its manifest offers \`"slot": { "paper": "author" }\`, the authors list it, and the reader
has the plugin installed: listing it installs nothing. It may read what it may read anywhere; nothing a plugin does
changes the page. The authors' \`settings\` reach it as \`pp.context.surface.config\`, so say in your README what
they can set. \`pp.supports(method)\` says whether this site answers a method, and \`pp.call(method, params)\`
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
  bins, and the same split by outcome (\`accepted\`, \`rejected\`, \`withdrawn\`, \`pending\`). \`?marks=true\` adds
  \`marks\`: the scope's own submissions there, each with its paper (\`identifier\`, \`address\`, \`title\`), mean and
  outcome, ascending (\`null\` above 1,000). Every venue in these answers carries \`venue.page\`, the venue's own page
  (or \`null\`): on a topic or an org the numbers are only its papers', so draw the whole venue from
  \`venue.page\`'s statistics and mark the scope's papers on it, as score standing's org view does
- \`GET ${origin}/api/v1/pages/<identifier>/papers?fields=submissions,scores,status&limit=&after=\`: a scope's papers
  as NDJSON, one a line, with every submission, its status and each review's score vector (\`scope.papers\`). Without
  \`limit\`, all of them in one stream; with it, one chunk and the next cursor in \`X-Next-Cursor\`. Compressed when asked.

The score and paper routes send an \`ETag\` and answer \`If-None-Match\` with a 304: cache what you fetch (in your
origin's IndexedDB) and ask again with the tag. Statistics are recomputed a few seconds after a change; curve-fitting
and percentiles are yours to do from \`values\`. A site may withhold a venue's statistics until its decisions are out
(\`hidden: true\`, with no values). Reviews are CC BY 4.0: show each one's licence and link with what you draw from
it. The OpenAPI description of these routes is at ${origin}/openapi.json.

## Signals

A **signal** is one value per paper that an app computes: an embedding, a position on a map, a score ("rigour",
0 to 1), a label ("uses diffusion"). Signals come in **sets**, one per app, and any plugin, and search, can use any set:
one person's way of reasoning about papers becomes everyone's tool. Every value is shown with the set it came from.

**Publish a set.** Declare its signals in your manifest's \`contributes.signals\`, and name the account that writes
them as \`publisher\` (its handle). Committing that file to your repo is how you say the account is yours.

\`\`\`json
{
  "id": "<owner>/<name>",
  "publisher": "<your handle>",
  "contributes": {
    "signals": [
      { "id": "map.xy", "kind": "vector", "dims": 2, "title": "Position on the map" },
      { "id": "map.region", "kind": "label", "title": "Region" },
      { "id": "embedding", "kind": "vector", "dims": 64, "metric": "cosine", "title": "Embedding" },
      { "id": "rigour", "kind": "number", "min": 0, "max": 1, "higher": "better", "title": "Rigour" }
    ]
  }
}
\`\`\`

Kinds: \`vector\` (\`dims\` up to 2048, \`metric\` \`cosine\`, \`dot\` or \`l2\`), \`number\` (\`min\`, \`max\`, \`higher\`
\`better\`, \`worse\` or \`neither\`) and \`label\` (a key per paper; its titles are written separately, since a map's
regions change with every rebuild). Then, as the publisher, with an API key that may write (made on your profile):

- \`POST ${origin}/api/v1/signal-sets\` \`{ "source": "github:<owner>/<repo>" }\` registers the set, or takes its
  manifest again after you change it.
- \`PUT ${origin}/api/v1/signal-sets/<owner>/<name>/values\` \`{ "values": [{ "paper": "openreview:abc", "signal":
  "rigour", "value": 0.8 }] }\`, up to 5,000 a request; \`"value": null\` removes one. Papers are named by identifier
  and matched when read, so a value may arrive before its paper does.
- \`PUT …/labels\` \`{ "signal": "map.region", "labels": [{ "key": "3", "title": "llm agents · skills" }] }\`.
- **A rebuild swaps in at once:** \`POST …/generations\` starts a new generation beside the live one; write all of it
  with \`?generation=<n>\` on the two routes above; then \`POST …/generations/<n>/publish\` makes it live and drops the
  old one. Without \`?generation\`, writes go to the live generation.

**Keep it current** with the events feed: \`GET ${origin}/api/v1/events?kind=paper&after=<cursor>&wait=25\` gives
every commit to every paper, oldest first, and \`next\`, the cursor to read after. Read again at once while \`more\` is
true; with nothing new, \`wait\` holds the request until a commit lands. It never skips one, so keep \`next\` and you can
stop and start where you left off (or begin at \`after=now\`). Each event names the paper with all its
\`identifiers\`, the files its commit changed (\`paths\`: recompute when the ones you read changed, e.g.
\`metadata.json\`), \`created\` for a new paper, and \`merged\` when another paper was folded into it. A small follower:
\`examples/signals/follow.mjs\` in the PotentialPaper repo.

**Read a set** with \`pp.signals\` (no permission needed: signals are public), or over HTTP:
\`GET ${origin}/api/v1/signal-sets\`, \`…/<owner>/<name>\`, \`…/<owner>/<name>/columns?signals=a,b&scope=<identifier>&titles=true\`,
\`…/<owner>/<name>/nearest?signal=<id>&paper=<identifier>&k=20\`, and \`GET ${origin}/api/v1/pages/<identifier>/signals\`.

## Your own backend

A plugin can have a server of its own, for what the site doesn't keep: a reader's private notes, a model's
predictions, data from another service. The site never runs it and it never sees the reader's session.

1. **List its origin in \`network\`** (\`"network": ["https://api.example.org"]\`). Those origins, and the plugin's
   own, are the only places its frames may connect to (CSP \`connect-src\`). The approval prompt names them, and adding
   one in an update asks the reader again. The backend answers CORS for the plugin's origin (or \`*\`: it is called
   with a bearer token, not cookies).
2. **To know who the reader is, ask for \`identity\`** (\`"permissions": ["identity"]\`). \`pp.identity.token()\` gives a
   JWT the site signs for the signed-in reader, good for ${IDENTITY_TOKEN_SECONDS / 60} minutes (the host keeps one while it
   has more than a minute left, so ask for it on every request); \`pp.identity.fetch(url, init)\` sends it as
   \`Authorization: Bearer …\`. Signed out, it fails with \`Unavailable\`. Only the reader can approve \`identity\`, in their
   browser, even for a plugin the site installs for everyone: until they do, such a plugin runs without it
   (\`PermissionDenied\`).
3. **The backend verifies the token** against the site's keys, ${origin}${JWKS_PATH} (ES256, a JWKS; fetch it again
   when a token names a \`kid\` you don't have, since keys rotate). Check:
   - the signature, with the key whose \`kid\` the token's header names, and \`alg\` \`ES256\`;
   - \`iss\` is \`${new URL(origin).origin}\`;
   - \`aud\` is your plugin's id. A token for another plugin is refused this way, so a plugin can't pass its readers'
     tokens to yours;
   - \`exp\` (and \`nbf\`), with a minute's leeway.

   Then key what you keep by \`sub\`: the reader's id for your plugin, stable when they change their handle, and
   different for every plugin, so backends can't join their users by it. \`handle\` is their handle, for showing.
   The claims: \`iss\`, \`aud\`, \`sub\`, \`handle\`, \`plugin\`, \`iat\`, \`nbf\`, \`exp\`, \`jti\`.
4. **While developing**, a plugin loaded from localhost gets tokens for \`aud\` \`dev:<plugin id>\` (with \`dev: true\`),
   since anyone can claim any id on their own machine. Accept them only in a backend you run locally; its frames are
   served by your dev server, so \`network\` doesn't limit them there (\`pp.context.plugin.dev\` says which you are).

In the frame:

\`\`\`js
const API = pp.context.plugin.dev ? 'http://localhost:8787' : 'https://api.example.org';
const res = await pp.identity.fetch(\`\${API}/notes?page=\${encodeURIComponent(pp.context.page.identifier)}\`);
\`\`\`

In the backend (Node; any JWT library with ES256 and JWKS does the same, such as \`jose\` or PyJWT):

\`\`\`js
import { createRemoteJWKSet, jwtVerify } from 'jose';
const keys = createRemoteJWKSet(new URL('${origin}${JWKS_PATH}'));
const { payload } = await jwtVerify(token, keys, { issuer: '${new URL(origin).origin}', audience: '<owner>/<name>', algorithms: ['ES256'] });
// payload.sub: the reader, for your plugin; payload.handle: their handle
\`\`\`

A complete example without dependencies is the "Private notes" plugin in the site's repo: the plugin,
\`examples/plugins/notes\` (https://github.com/PotentialHedge/potentialpaper/tree/main/examples/plugins/notes), keeps
each reader's notes on any page in its backend, \`examples/plugins/notes-backend\`, whose \`verify.mjs\` checks a token
with Node's own crypto and refetches the keys after a rotation.

**Writing to pages.** A backend never writes shared state through the RPC or a reader's token. Data for everyone
(scores, links, results) is written to pages as files by a **bot**: an account the site grants folders by path, whose
commits show as a bot's. Today a bot can be granted a source's review imports (\`reviews/<source>/**\`, as the site's
\`openreview\` bot is), by the site's admins; \`extensions/<plugin id>/\` is reserved for plugins' own bots, which come
with registering a bot yourself, bot tokens and webhooks (not yet). Name the bot in the manifest's \`bot\`, so the
approval prompt says whose data the plugin shows, and read its files with \`pp.page.read\` or \`pp.reviews.forPaper\`.

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
