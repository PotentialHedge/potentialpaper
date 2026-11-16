# Handoff: settings.json, plugins from GitHub, data for plugins, and the score-standing plugin

Status: plan, 2026-11-16. Nothing here is built yet.

## Goal

Make the site as extensible as we can safely make it. Anyone with a public GitHub repo can add panels to any page:
a paper, a venue, a topic, an organisation or a person (`handoffs/pages.md`). Readers find those plugins and install
them, and each reader's site and plugin preferences live in one
`settings.json`, as in VS Code and Presio. The first plugin outside this repo is **score standing**, the acceptodds
"where you stand" figure for review scores. It shows the histogram and the continuous curve, and it lives at
`github.com/benedict-armstrong/potentialpaper-score-standing`.

This is IMPLEMENTATION.md Milestone 8 (Extensions v0), brought forward, with DESIGN.md §10 as its design. Where this
file and §10 differ, this file wins. Phase 1 updates §10 to match.

Prior art to read before starting: Presio's plugin system (`gh api repos/PotentialHedge/presio/contents/<path>`):
`shared/plugin/{manifest,protocol,sources,settings,refs}.ts`, `client/src/lib/plugins/{resolve,registry,discover}.ts`,
`client/src/lib/plugins/host/*`, `client/src/lib/settings.ts`, `server/routes/plugins.ts`,
`server/agent/content/plugins.md`. For the charts, see acceptodds (`~/projects/papermarket/platform`):
`src/lib/distribution.ts`, `src/components/StandingChart.tsx`, `src/components/VenueStanding.tsx`,
`src/server/venue-field.ts`, `src/server/field-snapshot.ts`.

## Decisions (made with Benedict, 2026-11-16)

- **One `settings.json` per account, layered as in VS Code.** The layers are defaults, then site settings, then the
  user's. Defaults come from the core schema and from each installed plugin's `contributes.settings`. An admin sets
  the site layer. The user layer is the account's document. Keys are dotted (`paper.panels.hidden`). Plugin keys are
  namespaced by plugin id (`benedict-armstrong/score-standing.view`). The document holds only what differs from the
  layer below it. Values are checked when read and never trusted when written, so a bad value reads as the default
  rather than breaking the page. Settings are **preferences**. Remembered state, such as dismissed prompts or a
  plugin's cache, stays out of the document, as VS Code keeps it out of its `settings.json`.
- **Plugins load from GitHub, pinned to a commit.** A plugin is a public repo with a `potentialpaper-plugin.json`
  manifest and built files committed to the repo. We never run a build. Installing resolves a tag or branch to a
  SHA, and the server copies the files at that SHA once. This is the demos pipeline: `server/demos/github.ts`
  (codeload tarball) and `tar.ts`, with R2 for storage.
- **Each plugin runs on its own origin.** A plugin is served at `<plugin host>.ppusercontent.com/<sha>/…`, where
  the host label is a stable hash of the plugin id. Its frame is `sandbox="allow-scripts allow-same-origin"`. The
  same-origin flag is safe only because that origin is the plugin's own, on a different site from the app. It lets
  a plugin keep its own IndexedDB cache across versions. The CSP comes from the manifest (see D below).
- **The only bridge is a typed `postMessage` RPC.** Each call is checked against the permissions the user granted.
  A plugin never touches the host's DOM or session. Plugins declare what they add (panels, settings, commands), and
  the host draws it.
- **Consent is not in settings.json.** The document lists installed plugins, and a hand-edited file can add one. A
  grant row records which plugin id, at which SHA, received which permissions. A plugin with no matching grant shows
  an approval prompt instead of running. New permissions in an update need consent again.
- **Data for plugins comes three ways (A, B and D). Plugins never write state that other users share.**
  - **A: aggregates the site computes.** A `scope_stats` outbox consumer keeps per-score-field statistics for each
    **scope**: any page above the paper (a venue, a topic, an org), over its members in `page_members`
    (`handoffs/pages.md`). It is rebuildable like every consumer (DESIGN.md §4.9) and served by the REST API and by
    the RPC.
  - **B: generic bulk reads.** A scope's papers with their submissions, score vectors and decisions, with an ETag,
    for plugins that want their own statistics. They cache it in their own origin's IndexedDB.
  - **D: plugins with their own backend.** The manifest's `network` list goes into the plugin's CSP `connect-src`.
    A backend can also be a bot (DESIGN.md §10) that reads the events API and commits files of a known type through
    a grant.
  - **Not C.** Shared state that clients can write can be poisoned by anyone. Shared derived state comes from the
    site (A) or from the plugin's own backend (D). Per-user plugin storage is fine and comes in Phase 1.
- **Score standing is external.** It lives in Benedict's GitHub, goes through discovery like anyone's, and gets no
  host code of its own. If it needs something from the host, the host API grows for everyone.

## Phases (one agent each; update this file at the end of yours)

### Phase 1: settings.json

- `user_settings(user_id pk, doc text, updated_at)`. Keep the **text** (JSONC, so comments and order survive), and
  parse it when read. Signed-out readers use localStorage, offered for import when they sign in.
- Site layer: `config/settings.json` in the repo, or a `site_settings` row, whichever deploys more simply. Admins
  edit it by script.
- `lib/settings/`: a core schema (zod, one entry per key with default and description) and resolution
  (`defaults ← site ← user`), shared by server and browser. Port Presio's `SettingSpec` and
  `sanitizeSettingValue` (`shared/plugin/settings.ts`) for plugin-declared settings.
- `GET/PUT /api/v1/me/settings` returns the raw text and the resolved values. PUT validates and reports every problem,
  each on one line naming its key, as Presio's manifest validator does. Unknown keys are kept, with a warning, so a
  file can name a plugin's settings before that plugin is installed. Agents and scripts use the same route.
- `/schemas/settings.json` is the JSON Schema of the core keys plus the requesting user's installed plugins' keys,
  served the way `PAGE_SCHEMAS` are, so the editor can complete and validate.
- `/settings` has a form generated from the schema, plus "Edit settings.json": a raw editor with schema validation.
  Use the web editor's Monaco if it is cheap to embed. Otherwise use a plain editor with server validation. The page
  also has Export and Import.
- First core keys should be real ones: `<kind>.panels.hidden` and `<kind>.panels.order` for each page kind (readers turning built-in
  renderers off, DESIGN.md §4.8), `feed.showBots`, and `theme` if a theme switch exists by then. Don't invent
  settings to fill the list.

### Phase 2: the plugin host

- **Manifest** (`lib/plugins/manifest.ts`, zod, JSON Schema at `/schemas/plugin-manifest.json`): `id`, `name`,
  `version`, `apiVersion`, `main` (an HTML file), `permissions`, `network` (origins, https only), and `contributes`:
  `panels` (`{ id, title, kinds, slot, when? }`, where `kinds` names the page kinds (`paper`, `venue`, `topic`, `org`,
  `user`) and `slot` is `main`, `aside` or `tab`, resolved against the kind's slots), `pages` (whole pages of the
  plugin's own, at `/x/<plugin>/…`), `settings`, and `commands`. Unknown fields are warnings, not errors, so a newer
  manifest still loads on an older host. The validator reports every problem in one pass.
- **`when` conditions** (`page.kind == venue`, `page.hasScores`, `page.hasSubmissions`, `signedIn`,
  `viewer.isOwner`) let the host decide whether to show a panel at all, so a page doesn't start a frame per installed
  plugin. These are activation events, as in VS Code. Each kind declares the context keys it offers, in the kind
  registry.
- **Sources and snapshots:** `github:<owner>/<repo>[/path][@ref]`, resolved to a SHA on the server with
  `GITHUB_TOKEN`. Copy the files once into R2, keyed by SHA, reusing the demos code. Limits: total size, file count,
  and a list of allowed extensions (the demos' list plus `png`, `woff2` and `wasm`). The manifest is validated when
  the snapshot is taken.
- **Serving** (`server/plugins/serve.ts`, beside `demos/serve.ts`):
  - CSP `default-src 'self'`.
  - `connect-src 'self' <network…>`.
  - `frame-ancestors` the site.
  - Immutable caching per SHA.
- **Dev mode:** a source of `http://localhost:<port>/` runs unpinned, for that browser only. This is how a plugin
  author works against `npm run dev`.
- **The host** (`components/plugins/PluginFrame.tsx`):
  - Frames go in the generic per-kind slots from `handoffs/pages.md` Phase 1 (`<kind>.main`, `<kind>.aside`,
    `<kind>.tabs`). Build it for every kind from the start, even if only paper pages exist yet.
  - Frames are sized by `ui.setHeight`.
  - Theme tokens are sent on load and on change, so plugins can match light and dark.
  - Frames load lazily when scrolled into view.
- **RPC protocol** (`lib/plugins/protocol.ts`), versioned. It starts with:
  - `context.get`: the page (`kind`, identifier, address), its **scopes** (for a paper: its venues, topics and orgs;
    for a topic: its broader topics; for an org: its parents), viewer signed in or not, theme.
  - `settings.get`, `settings.set` (own keys only), and a `settings.change` event.
  - `storage.get` and `storage.set`: per user and per plugin, 64 KB, in Postgres, for small state that should follow
    the account.
  - `page.read` (permission `page.read`): the current page's kind file, sections and links, for any kind. For a
    `user` page, this is only what the §5.3 rules let the public see.
  - `page.members` (permission `scope.read`): a venue's, topic's or org's papers, paged, with roll-up from children.
  - `page.resolve`: any identifier (`venue:iclr/2027`, `topic:…`) to a page's summary, so a plugin can follow links.
  - `reviews.forPaper` (permission `reviews.read`): a paper's submissions, notes and venue forms, from
    `submissions.ts`.
  - `ui.setHeight` and `ui.openUrl`.
- **SDK:** one file served immutably at `https://ppusercontent.com/sdk/v1/pp.js`, with `pp.d.ts` in the repo and in
  the guide. It works with no build step. An npm package can come later.
- **Install and consent:** `user_plugin_grants(user_id, plugin_id, sha, permissions, granted_at)`. The `plugins` key
  in settings.json maps each source to `{ enabled, ref }`, as in Presio's `CoreSettings["plugins"]`. A prompt lists
  the permissions and the network origins in plain words.
- **Kill switch and defaults:** the site layer has `plugins.blocked` (ids, or ids at a SHA) and `plugins.default`
  (sources installed for everyone, which a user can turn off).
- Prove it with `examples/plugins/hello/`, an in-repo plugin used by the tests: it reads the context and a setting,
  and stores a value.
- Update DESIGN.md §10 and IMPLEMENTATION.md Milestone 8 to match what was built.

### Phase 3: discovery and the plugin pages

- `GET /api/v1/plugins/discover`: public repos with the GitHub topic **`potentialpaper-plugin`**, most starred first,
  cached for 5 minutes with a stale list served while GitHub fails. Port Presio's `server/routes/plugins.ts`.
- `/settings/plugins`:
  - Installed: on/off, version, settings, permissions, remove.
  - Discover: the topic list with stars, description and last push.
  - Add by source: a GitHub URL or `owner/repo`.
  - Load from localhost, for development.
- Update check: a newer tag shows "Update". If the update needs new permissions, it asks before switching.
- **A guide for agents**, `/plugins.md`, linked from `llms.txt`. It covers the manifest, SDK, permissions, data
  routes, the dev loop and publishing (tag a release, add the topic). Its README line is Presio's: "Read
  https://…/plugins.md and build me a PotentialPaper plugin."

### Phase 4: data for plugins (A and B)

- **A, the `scope_stats` consumer** (`server/scope-stats.ts`). It reads `submissions`, `submission_notes` and
  `page_members` rather than repos, so it runs after the reviews projection and the membership consumer. Either chain
  it off them, or have it read events and recompute the affected scopes. Pick whichever is simpler and idempotent.
  - Per `(scope, venue, field)`, for every field the venue's forms mark `score`, it keeps the items below. The
    venue stays in the key even for topics and orgs, since a 6 at ICLR and a 6 at NeurIPS are different scales.
    A scope that is a venue has a single venue.
    - every submission's mean over its reviews, sorted (reuse the means in `lib/submissions.ts`);
    - the count;
    - `min` and `max` from the form;
    - fixed-width bins;
    - the same split by `status` (accepted, rejected, withdrawn, pending).
  - Recomputing one scope is a single SQL aggregate. ICLR is about 40k submissions, so it runs on change and is
    debounced per scope. `consumers:rebuild -- scope-stats` rebuilds it.
- `GET /api/v1/pages/{identifier}/scores` lists the venues, fields and counts for any scope.
  `GET /api/v1/pages/{identifier}/scores/{venue}/{field}` returns the
  sorted values, bins, the split by status, and `computedAt`. Both are public, use ETags, and are cached by the CDN
  for a minute. This is the data the standing figure needs. Leave curve-fitting to the client: it is view logic, and
  20k numbers is nothing.
- **B, bulk:** `GET /api/v1/pages/{identifier}/papers?fields=submissions,scores,status` streams NDJSON for any
  scope. Each row has the paper, its submissions and statuses, and every review's score vector. It is gzipped,
  ETagged on the scope's last change, and public, because the reviews are CC BY and the licence and source link
  travel with the data.
- RPC: `scope.scores(identifier, venue?, field?)` and `scope.papers(identifier)` (streamed in chunks), behind the
  `scope.read` permission.
- Add both routes to the published API docs and the OpenAPI, so outside backends (D) use the same data.

### Phase 5: plugins with their own backend (D)

- `network` origins go into the plugin's CSP `connect-src`. They are shown in the consent prompt, and a new origin
  needs consent again. The backend is the plugin's own: it gets no session, and if it wants the viewer's identity it
  asks for an `identity` permission (next point).
- `identity` permission: `identity.token()` returns a short-lived signed token naming the user and the plugin id,
  audience-bound to that plugin, so a backend can verify a viewer without ever seeing their session. Publish the
  verification key at `/.well-known/jwks.json`.
- A manifest's optional `bot` field names the bot account a plugin writes through, so the consent prompt can say
  what that plugin's data on pages comes from. Bot registration for outsiders, tokens and webhooks remain
  Milestone 7. Only pull them forward if a plugin needs them.
- Document the pattern in `/plugins.md` with a small example backend.

### Phase 6: score standing (external)

Repo: `benedict-armstrong/potentialpaper-score-standing`, MIT, with the topic `potentialpaper-plugin`. Vite and
TypeScript, with `dist/` committed (we never build) and CI that fails if `dist/` is stale. Release by tagging
`v0.1.0`.

- Manifest:
  - Permissions: `reviews.read`, `scope.read`.
  - One panel for `kinds: [paper, venue, topic, org]`, `slot: aside` on papers and `main` elsewhere,
    `when: page.hasScores`.
  - Settings:
    - `view`: `both` (default), `histogram` or `curve`.
    - `field`: a string naming the score field; empty means the venue's first, usually the overall rating.
    - `splitByDecision`: `auto` (default; on once decisions are out), `on` or `off`.
- The figure, ported from acceptodds:
  - **(a) Histogram** (`VenueStanding`): the venue's bins, with this paper's bin marked and the share below shaded.
    Hovering a bar shows its range, its count and its share.
  - **(b) Curve** (`StandingChart`): a kernel density of the means (`lib/distribution.ts`: `bandwidth`, `density`,
    `rootScaled`), the area below the paper shaded, and a line at the paper labelled with its band ("Top 12%").
    Hover and arrow keys read off "N papers below".
  - Scores are discrete (ICLR rates on {1, 3, 5, 6, 8, 10}), so means bunch at a few values. Choose the bandwidth so
    the curve doesn't invent modes between them. The histogram shows the bunching honestly, which is why both are
    shown.
  - After decisions, both figures split by outcome, which shows the accept rate per bin.
  - With several submissions (rejected at one venue, accepted at the next), there is a tab per venue.
  - A field switcher lists the venue's score fields (rating, soundness, presentation, …) and changes the `field`
    setting.
- One figure, shown differently on each kind of page:
  - **Paper:** the paper's standing at its venue, plus "among papers in <topic>" for each of its topics. The topic
    view uses that topic's statistics at the same venue.
  - **Venue:** the whole distribution, split by decision once decisions are out. This is the venue's "how hard was
    it" figure.
  - **Topic:** the topic's papers at each venue, with a venue switcher, against the venue's whole distribution in
    outline, which shows whether a topic scores above its venue. Topics are small, so a venue is offered only once
    the topic has enough scored papers there (acceptodds' `MIN_FIELD`, raised to something like 10). Otherwise the
    panel lists the papers' scores instead of a figure.
  - **Org:** the venue's distribution, with the org's papers as open circles on the curve, named on hover. This is
    acceptodds' `marks`.
- Data comes from A only (`scope.scores`). The plugin caches by ETag in its own IndexedDB, so moving between papers
  at the same venue costs nothing.
- It looks right in both themes using the host's tokens, works at phone width, and has an accessible name and a
  text summary for screen readers, as acceptodds' figure has.
- Later (v0.2): the paper's position before and after rebuttal, from the review files' git history. This needs a
  `reviews.history` RPC in the host.

## Open questions

- Showing rank during reviewing: the data is public and acceptodds shows prices, but a percentile on the paper's own
  page while reviews are still open is a stronger statement. One option is a site setting, `plugins.venueStats.hideUntil`
  (`decisions` or `never`), that A respects.
- Which plugins go in `plugins.default`, if any, at launch.

## Log

**How the phases run:** one T3 thread per phase, on its own branch (`plugins-phase-<n>`), cut from the previous
phase's branch so this file stays current. Commit and push after each working step. At the end, add your entry below
and launch the next phase's thread pointing at this file. Merging into `main` waits for Benedict.
Phase 1 (settings) can start at once. Phase 2 needs `handoffs/pages.md` Phase 1 (the page model). Phases 4 and 5
need Phase 2, and Phase 4 also needs `page_members`. Phase 6 needs Phases 2–4, and its venue, topic and org views
need those kinds' pages (`handoffs/pages.md` Phases 2, 4 and 5). The paper view can ship first.

Suggested order: plugins 1 → pages 1 → plugins 2 → pages 2 (venues) → plugins 3, 4 → plugins 6 (paper and venue
views) → pages 3, 4, 5 alongside plugins 5 → the topic and org views of score standing.
