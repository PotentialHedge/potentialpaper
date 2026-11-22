# Handoff: settings.json, plugins from GitHub, data for plugins, and the score-standing plugin

Status: plan, 2026-11-16. Every phase is built: 1 (settings.json), 2 (the plugin host), 3 (discovery and the plugin
pages), 4 (data for plugins, A and B), 5 (plugins with their own backend, D) and 6 (score standing: paper and venue
views in v0.1.0, the org view in v0.2.0); see the Log. What remains is "Later (v0.2)" of Phase 6, before/after
rebuttal (a `reviews.history` RPC), and the open question of `plugins.default`.

## Goal

Make the site as extensible as we can safely make it. Anyone with a public GitHub repo can add panels to any page:
a paper, a venue, a category, an organisation or a person (`handoffs/pages.md`). Readers find those plugins and install
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
    **scope**: any page above the paper (a venue, a category, an org), over its members in `page_members`
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
  `panels` (`{ id, title, kinds, slot, when? }`, where `kinds` names the page kinds (`paper`, `venue`, `category`, `org`,
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
  - `context.get`: the page (`kind`, identifier, address), its **scopes** (for a paper: its venues, categories and orgs;
    for a category: the categories it is in; for an org: its parents), viewer signed in or not, theme.
  - `settings.get`, `settings.set` (own keys only), and a `settings.change` event.
  - `storage.get` and `storage.set`: per user and per plugin, 64 KB, in Postgres, for small state that should follow
    the account.
  - `page.read` (permission `page.read`): the current page's kind file, sections and links, for any kind. For a
    `user` page, this is only what the §5.3 rules let the public see.
  - `page.members` (permission `scope.read`): a venue's, category's or org's papers, paged, with roll-up from children.
  - `page.resolve`: any identifier (`venue:iclr/2027`, `category:…`) to a page's summary, so a plugin can follow links.
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
    venue stays in the key even for categories and orgs, since a 6 at ICLR and a 6 at NeurIPS are different scales.
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
  - One panel for `kinds: [paper, venue, org]` (not categories), `slot: aside` on papers and `main` elsewhere,
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
  - **Paper:** the paper's standing at its venue.
  - **Venue:** the whole distribution, split by decision once decisions are out. This is the venue's "how hard was
    it" figure.
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
need Phase 2, and Phase 4 also needs `page_members`. Phase 6 needs Phases 2–4, and its venue and org views need
those kinds' pages (`handoffs/pages.md` Phases 2 and 4). The paper view can ship first.

Suggested order: plugins 1 → pages 1 → plugins 2 → pages 2 (venues) → plugins 3, 4 → plugins 6 (paper and venue
views) → pages 3, 4, 5 alongside plugins 5 → the org view of score standing.

### Phase 1: settings.json (2026-11-16, branch `plugins-phase-1`)

Built:

- **Tables** (`drizzle/0031_settings.sql`): `user_settings(account_id pk → accounts, doc text, updated_at)` and
  `site_settings(id = 1, doc text, updated_at)`. Texts are stored as written (JSONC) and parsed when read.
- **`lib/settings/`**, shared by server and browser: `core.ts` (the core settings, zod, each with default, title,
  description, group and a form widget), `spec.ts` (Presio's `SettingSpec` and `sanitizeSettingValue`, plus
  `settingValueProblem`, `PLUGIN_ID_RE`, `qualify`/`splitQualified`), `document.ts` (parse, `checkSettings`,
  `resolveSettings` for defaults ← site ← user and plugins' specs, `setInSettings` that edits one key and keeps
  comments and order), `schema.ts` (JSON Schema) and `client.ts` (the browser store, `useSetting`).
- **Routes:** `GET`/`PUT /api/v1/me/settings` (the PUT body is the file itself; a 422 `validation_error` says
  `settings.json has N problems:` and then one line per error naming its key, with `details.problems` carrying
  severity, key, line and message; warnings come back in `problems` on success; a `read` token can GET but not
  PUT). `GET /api/v1/settings` (public: the site layer and what it resolves to, for signed-out readers).
  `/schemas/settings.json` (private, per account, beside `PAGE_SCHEMAS` in `app/schemas/[file]`).
- **`npm run settings:site`**: print the site layer, `set <file|->` to replace it, `put <key> [json]` to set or
  remove one key keeping the rest. Checked as a user's file is; nothing is saved with errors.
- **`/settings`** (linked in the navbar for everyone): a form made from `CORE_SETTINGS` (a "toggles" widget for
  hidden panels, an "order" widget with up/down per slot, and "reset" per key), "Edit settings.json" (a textarea
  checked live by the shared validator, problems listed by line and clickable), Export (downloads the file) and
  Import (loads a file into the raw editor to look over and save).
- **First core keys:** `paper.panels.hidden` and `paper.panels.order`, made per kind from `lib/panels.ts`
  (`PAGE_PANELS`: each built-in panel's stable id, slot and title). `components/paper/slots.tsx` renders each slot's
  panels on the server and hands them to `components/ArrangedPanels.tsx`, which hides and orders them in the
  browser. `order` puts the named panels first within their own slot, the rest after in their usual order.
- **Signed out:** the file lives in localStorage (`pp.settings`). After sign-in, `components/SettingsImport.tsx`
  (under the navbar) offers to import it, key by key over the account's file, or discard it; either clears it.
  `NavUser` tells the store when the reader signs in or out, so it refetches.
- Agents: a line in `llms.txt` and a dated notice in `/agent/updates`.
- DESIGN.md §10 rewritten to match this plan (settings.json, the model, own origin per plugin, consent outside
  settings, data A/B/D not C, `plugins.default` and `plugins.blocked`); IMPLEMENTATION.md Milestone 8 notes it.

Calls I made where the plan left room:

- `user_settings` is keyed by **`account_id`**, not `user_id`: the account is the identity here
  (`paper_follows` and the rest key on it), and `user_id` would read as Better Auth's `user` table.
- **Site layer as a row, not `config/settings.json`**: Phase 2's kill switch (`plugins.blocked`) must act without
  a deploy, and a row does. Cached for 10 s per process.
- **`feed.showBots` is not added.** There is no activity feed yet (`/changes`, DESIGN.md §7), and a page's history
  isn't one: a setting that nothing reads is what the plan says not to add. Add it with the feed. **`theme`** waits
  for a theme switch, which doesn't exist. The mail preferences (`mentionMail`, `followMail`) stay account columns:
  the server's mailers read them, and moving them wasn't asked for.
- **No Monaco.** The web editor is a whole VS Code workbench (`public/editor/vscode`), with no standalone Monaco
  to embed cheaply, so the raw editor is a textarea with the shared validator running as you type and the server
  checking again on save. It has no completion; the schema at `/schemas/settings.json` is there for editors that do.
- **Panels apply after load.** Paper pages are the same HTML for every reader (the edge caches them), so hidden and
  reordered panels are applied in the browser. The last resolved values are cached in localStorage
  (`pp.settings.resolved`, state rather than settings) so a returning reader's arrangement applies on the first
  client render rather than after a fetch; a first visit shows the defaults for a moment.
- **Panel ids are strict on write, lenient on read:** a PUT naming an unknown panel is an error; when reading, an
  id that no longer exists is dropped and the rest still applies. Unknown keys, and keys of plugins not installed,
  are warnings and kept.
- **Removing a key keeps the comments around it.** jsonc-parser's own removal drops a comment on the next line,
  so `setInSettings(…, undefined)` removes only the property's own line(s), its comma and a comment on its line.
- `GET /api/v1/settings` is new (not in the plan), so signed-out readers get the site layer.

For Phase 2:

- `server/settings.ts`'s `installedPluginSettings(account)` returns `[]`; make it read the `plugins` key and the
  installed manifests' `contributes.settings`. Everything downstream (resolve, check, the JSON Schema, the GET)
  already takes that list. The browser store (`lib/settings/client.ts`) resolves signed-out readers' files against
  core settings only; it needs the plugin list too.
- Add `plugins` (with a sanitizer, as Presio's `sanitizePluginList`), `plugins.default` and `plugins.blocked` to
  `CORE_SETTINGS`. The form shows a key only if it has a widget; give these one or leave them to Phase 3's
  `/settings/plugins`.
- Plugin panels join slots in `ArrangedPanels`. `<kind>.panels.hidden`/`order` only accept built-in ids for now;
  widen them to plugin panel ids (`<plugin id>.<panel id>`) there.
- When `handoffs/pages.md` Phase 1 adds kinds, add their panels to `PAGE_PANELS` (or derive it from the kind
  registry) and their settings appear on their own.

Checks: `npm run typecheck`, `npm run lint` and `next build` pass. Unit tests: 339 pass (9 new in
`tests/unit/settings.test.ts`). Integration: 247 of 254 pass, 5 new in `tests/integration/settings.test.ts`. The 7
failures are the same on the untouched branch: six in `pdf-ingest.test.ts` (no poppler on this host) and one in
`follows.test.ts` (its setup's `PATCH /me` returns 422). This worktree ran them against its own database,
`potentialpaper_test_plugins1`, through an untracked `.env`, so as not to migrate the shared test database under
other threads.

### Phase 2: the plugin host (2026-11-16, branch `plugins-phase-2`)

Built:

- **`lib/plugins/`**, shared by server and browser:
  - `manifest.ts`: the manifest in zod (`id`, `name`, `version`, `apiVersion: 1`, `main`, `permissions`,
    `network`, `contributes.{panels,pages,settings,commands}`), its JSON Schema at `/schemas/plugin-manifest.json`,
    and `validateManifest`, which reports every problem in one pass, each naming its field. Unknown fields are
    warnings, and so is a `when` key one of the panel's kinds doesn't offer. `PERMISSIONS` (`page.read`, `scope.read`,
    `reviews.read`) carries the consent prompt's words.
  - `when.ts`: the `when` grammar (`&&`, `||`, `!`, `==`, `!=`, parentheses) over the context keys each kind
    declares in `KindInfo.contextKeys`.
  - `sources.ts`: `github:<owner>/<repo>[/<folder>][@<ref>]`, also `owner/repo` and GitHub links, and
    `http://localhost:<port>/` for dev. A source's key is canonical and lower-cased, without the ref.
  - `protocol.ts`: Presio's envelopes over a `MessagePort`, booted by a hello/boot handshake. Also `HOST_METHODS`
    with the permission each needs, `FrameContext` and the theme tokens.
  - `host.ts`: the page's side of the RPC, pure (no React, no fetch). It checks the method, the permission and the
    params, then answers through the `HostServices` the page gives it.
  - `installed.ts`: which plugins a reader has (`installedEntries`), `isBlocked`, `missingConsent`.
  - `origin.ts`: plugin hosts, `plugin-<20 hex>.<content domain>`, and the SDK's address.
  - `client.ts`: the browser's plugin store, and dev plugins.
- **Tables** (`drizzle/0034_plugins.sql`):
  - `plugin_snapshots(source, commit)`, with the plugin id, host label, checked manifest, warnings and files.
  - `plugin_refs(source, ref) → commit`, the pin.
  - `user_plugin_grants(account_id, plugin_id, sha, permissions, network)`.
  - `user_plugin_storage(account_id, plugin_id, data)`.
- **`server/plugins/`**:
  - `snapshot.ts`: the demos pipeline. Git's ref listing resolves the ref, codeload's tarball brings the folder's
    files, and the demos' store (R2) keeps them by SHA-256. Kept are files of the content domain's types, outside
    dot-folders and `node_modules`. Limits: 500 files, 20 MB, 10 MB a file. The manifest is checked, and the id's
    owner must be the repo's owner. A refused copy lists every problem.
  - `serve.ts`: `/<commit>/<path>` on the plugin's host. The plugin's CSP (`pluginCsp`), immutable caching, and
    `frame-ancestors` the site.
  - `installed.ts`: the list a page runs, with each plugin's status (`ready`, `consent`, `blocked`, `disabled` or
    `error`). Also `pluginSettingsOf` (behind `installedPluginSettings`, which no longer returns `[]`), grants,
    install and uninstall.
  - `pages.ts`: `pageSummaries`, `scopesOfPage`, `pageFacts`, and the reads behind `page.read`, `page.members`,
    `page.resolve` and `reviews.forPaper`.
  - `storage.ts`: storage, 64 KB per account and plugin.
- **Routes:**
  - `GET /api/v1/plugins/installed[?page=<identifier>]`: auth optional. It gives `viewer.isOwner` for `when`, and
    copies a plugin that hasn't been copied yet.
  - `POST`/`DELETE /api/v1/me/plugins` installs or removes a plugin by source, editing settings.json's `plugins`
    and keeping the rest of the file.
  - `PUT`/`DELETE /api/v1/me/plugins/grants` grants or withdraws consent. PUT needs a browser session.
  - `GET`/`PUT /api/v1/me/plugins/storage`.
  - `GET /api/v1/pages/{identifier}` and its `/files`, `/members` and `/submissions`. The identifier is one
    URL-encoded segment. These are public and cached a minute.
  - `proxy.ts` sends plugin hosts to `servePlugin`, and the bare content domain serves only `/sdk/`.
- **Settings:** `plugins` (`{ "<source>": { enabled, ref } }`, read leniently by `sanitizePlugins`),
  `plugins.default` and `plugins.blocked`. The last two are `siteOnly`: they are resolved from the site layer only,
  and a user's file gets a warning. `<kind>.panels.hidden`/`order` accept `<plugin id>.<panel id>`.
  `setInSettings` takes a key path, so one source can be edited inside `plugins`. `GET /api/v1/settings` and
  `/me/settings` return the plugins' setting specs (`plugins`), and the browser store resolves and checks with
  them.
- **The host in the page** (`components/plugins/`):
  - `PluginPageProvider` is set by the paper route and the keyed-page route with the page's summary, scopes and
    facts.
  - `usePluginPanels(slot)` feeds `ArrangedPanels` and `ArrangedTabs` (both gained a `slot` prop) for every kind's
    `main`, `aside` and `tabs`.
  - `PluginPanel` shows the consent prompt or `PluginFrame`, with a commands menu. `PluginFrame` is lazy (it starts
    within 200px of the screen), sandboxed `allow-scripts allow-same-origin`, and sized by `ui.setHeight`. It sends
    theme tokens at boot and on change, plus `settings.change` and `context.change`.
  - `/x/<owner>/<name>/<page>/…` holds plugin pages (`PluginPageView`).
- **The SDK:** `public/sdk/v1/pp.js` (no build; it auto-sizes the frame, sets `--pp-<token>` CSS variables, and
  queues calls until boot) and `public/sdk/v1/pp.d.ts`.
- **`/settings`** gained a small Plugins section: the list with statuses, install by source, and load from
  localhost.
- **`examples/plugins/hello/`**: it reads its context and the `greeting` setting, counts visits in storage, reads
  the page (`page.read`), offers a `reset` command, and has an `about` page. It shows on every kind (aside on
  papers, main elsewhere).
- **Agents:** `llms.txt` lines and an `/agent/updates` notice (installing for a person; the page routes).
- DESIGN.md §10 and IMPLEMENTATION.md Milestone 8 updated.

Calls I made where the plan left room:

- **The manifest's `id` is checked against the source:** it must be `<repo owner>/<name>`, so nobody publishes
  under someone else's id. Presio derives the id from the source; the plan has an `id` field, and this keeps both.
- **`slot` can be per kind** (`{ "paper": "aside", "*": "main" }`), because Phase 6's figure is `aside` on papers and
  `main` elsewhere.
- **No `GITHUB_TOKEN`.** Refs resolve through git's ref listing, which needs no token and has no hourly limit, as
  demos do. Phase 3's discovery (the search API) will need the token.
- **The pin is per (source, ref), site-wide** (`plugin_refs`). The first install of a ref pins its commit, and
  nothing moves it until an explicit update (`snapshotPlugin(…, { update: true })`, unused until Phase 3). A
  reader moves to a new version by changing the ref.
- **Consent matches by coverage, not by commit.** A plugin runs if its grant covers the running manifest's
  permissions and network origins, so an update that asks for nothing new keeps running. The grant row keeps the
  commit that was approved.
- **Site defaults need no per-user consent.** They run with what they ask for, and the admin who adds one approves
  it. If a reader re-pins a default to another ref, it becomes theirs and needs their consent. Signed-out readers
  get the site's defaults only: installing needs an account, since grants are rows.
- **Approving needs a browser session** (`requireSession`), so an agent can install for a person but never consent
  for them.
- **Checks happen on the host's side, in the page:** permissions in `host.ts`, and status from the server's list.
  The data behind every permission is public anyway (the routes are public), so permissions say what a plugin
  takes an interest in. They don't guard secrets.
- **Dev plugins** live in localStorage (`pp.plugins.dev`), run unpinned with what they ask for, and need no
  consent, since the author added them on their own machine. The app's CSP gained `http://localhost:*` and
  `http://127.0.0.1:*` in `frame-src` and `connect-src`, so the browser can read a dev server's manifest. That
  server must send CORS headers. A dev plugin replaces an installed one with the same id.
- **The plugin CSP** adds to the plan's `default-src 'self'`: `'wasm-unsafe-eval'` (wasm is an allowed file type),
  `'unsafe-inline'` styles, `data:`/`blob:` images, `object-src 'none'` and `form-action 'none'`. Scripts may also
  come from the SDK's folder, both the site's own and `https://ppusercontent.com/sdk/`, so the same `index.html`
  works against a local site.
- **The SDK is cached for a day, not forever.** v1 only grows, and a fix to it should reach every plugin.
- **`page.hasScores`** on a paper is "a review has a score field" (`scoreTable`). On a scope it is "a member paper
  has a review", one `EXISTS` query; Phase 4's `scope_stats` can make that exact.
- **`page.members` and the other reads take an identifier**, so a plugin can read any page, not only its own. The
  data is public.
- **Commands** run in the panel whose menu they were picked from (`commands.run` to that frame). There is no global
  palette.
- **Storage when signed out** goes to localStorage on the app's origin (`pp.plugin-storage.<id>`), with the same
  64 KB cap.
- **`paper.body`** is the paper's own slot, which no plugin names, so plugin panels never join it.

For later phases:

- Phase 3:
  - `/settings/plugins` can grow out of `app/settings/PluginsSection.tsx`.
  - Updates: call `snapshotPlugin(source, { update: true })` to re-resolve a ref, or set a newer tag as the
    entry's `ref`. The listing's `missing` says what the consent prompt must ask.
  - The settings form shows no widget for `plugins*` and lists only built-in panels in the hidden/order widgets;
    plugin panels and settings need their own form there.
  - `/plugins.md` should document the RPC from `public/sdk/v1/pp.d.ts`, and the dev loop from
    `examples/plugins/hello/README.md`.
- Phase 4: add `scope.scores`/`scope.papers` to `HOST_METHODS` (permission `scope.read`) and handlers in `host.ts`,
  and routes beside `app/api/v1/pages/[identifier]/`.
- Phase 5: `network` already flows into the CSP and the consent prompt, and a new origin asks again. Add
  `identity` to `PERMISSIONS`.
- There is no OpenAPI document in the repo yet; the page routes are described in `llms.txt` and here.

Checks: typecheck, lint and `next build` pass. Unit tests: 367 pass (20 new in `tests/unit/plugins.test.ts`, among them the real SDK file against the real host over a `MessageChannel`). Integration: 265 of 272 pass, 7 new in `tests/integration/plugins.test.ts`. The 7 failures are the same as before this phase: six in `pdf-ingest.test.ts` (no poppler) and one in `follows.test.ts`. A smoke test on `next start` showed that a URL-encoded identifier (`/api/v1/pages/venue%3Aiclr%2F2027`) reaches the route and decodes, and that `/sdk/v1/pp.js`, `/schemas/plugin-manifest.json` and `/x/…` are served. These ran
against this worktree's own database, `potentialpaper_test_plugins2`, through an untracked `.env`.

### Phase 3: discovery and the plugin pages (2026-11-16, branch `plugins-phase-3`)

Built:

- **Discovery**, `server/plugins/discover.ts` (Presio's `server/routes/plugins.ts`, ported): GitHub's repository
  search for `topic:potentialpaper-plugin archived:false is:public`, most starred first, 100 at most. One search
  per five minutes per process, one at a time; after a failure, the last list is served (`stale: true`) and GitHub
  isn't asked again for a minute; with no list at all, a 502. `GITHUB_TOKEN` is sent when set. Each entry is keyed as
  a source (`github:<owner>/<repo>`), with description, stars, last push, link and topics. Route:
  `GET /api/v1/plugins/discover`, public, `Cache-Control: public, max-age=300`.
- **Releases and updates**:
  - `lib/plugins/versions.ts` (pure): versions as manifests and tags write them (`v1.2.0` or `1.2.0`), semver order,
    the newest release, and `updateFor(tags, runningVersion)`. Prereleases are never offered.
  - `server/plugins/tags.ts`: a repo's tags through git's ref listing (`listTags` in `demos/github.ts`, annotated
    tags peeled), cached ten minutes per repo, failures too.
  - `server/plugins/updates.ts`: `pluginUpdates` (each installed plugin whose newest release is newer than the
    `version` its running manifest says) and `updatePlugin` (copy the new ref first, check it is the same plugin id,
    compare its permissions and network with the reader's grant; switch, or answer `consent` with what's missing).
  - Routes: `GET /api/v1/me/plugins/updates`, and `POST` it `{ source, ref?, approve? }` (`ref` defaults to the newest
    release). `approve` needs a browser session; without it, an update that asks for nothing new still switches.
  - Installing with no ref now takes the newest release (`installPlugin`), or the default branch if there is none.
- **`/settings/plugins`** (`app/settings/plugins/`):
  - Installed: each plugin with an on/off box, name, version, ref and commit (linked to its folder on GitHub at that
    commit), status, id, author, where it came from, description and error; "Update" when a newer release is out,
    which shows what the new version asks for, with "Approve and update" or "Keep"; "What it may do" (each
    permission in the consent prompt's words and each network origin, marked when not approved yet, with Approve or
    Withdraw approval, and its panels, `when` conditions and pages); its settings as a form drawn from its
    `contributes.settings` (box, list, text and number fields, reset per key); Remove.
  - Discover (stars, description, last push, Install or "Installed"), Add by source, and Load from localhost.
  - The line for agents with the site's address: "Read <origin>/plugins.md and build me a PotentialPaper plugin."
  - Browser calls in `lib/plugins/client.ts`: `uninstallPlugin`, `revokePlugin`, `setPluginEnabled`,
    `fetchDiscovered`, `fetchUpdates`, `updatePluginTo`.
- **`/settings`**: its Plugins section is now a summary and a link to `/settings/plugins`. The `<kind>.panels.hidden`
  and `.order` widgets also list installed plugins' panels for that kind (`pluginPanelChoices` in
  `lib/plugins/installed.ts`), grouped by the slot each takes, and unticking keeps ids the form doesn't show.
- **`/plugins.md`** (`server/agent/plugins-guide.ts`): build one (repo, topic, files, try, tag, install), what a
  plugin is (id, source, pin, origin, CSP, file limits), the manifest field by field with an example, `when` keys
  per kind, permissions, the SDK's methods, events, theme tokens and identifiers, the data routes, the dev loop and
  publishing. The permission, method, `when`-key and theme-token tables are made from the code, and a unit test
  fails if a host method has no line. Linked from `llms.txt` (which also names the new routes), an `/agent/updates`
  notice, and the hello example's README.
- DESIGN.md §10 ("The model": releases and updates, `/settings/plugins`, `/plugins.md`; "Trust levels": discovery)
  and IMPLEMENTATION.md Milestone 8 updated.

Calls I made where the plan left room:

- **An update moves the reader alone.** It sets their entry's `ref` to the new tag. Re-resolving a ref site-wide
  (`snapshotPlugin` with `update: true`) stays unused: moving a shared pin would change the code other readers run
  without their asking.
- **"Newer" is against the running manifest's `version`**, not the ref, so a plugin installed from a branch or a
  commit is offered a newer release too. Only tags are offered (the plan's "a newer tag"). A reader tracking a branch
  gets new commits only by re-pinning; there is no "pull the branch again" button.
- **Updating a site default** re-pins it for that reader, which makes it theirs (`from: user`), so it needs their
  approval even if it asks for nothing new.
- **Discovery lists repos, not plugins.** It shows no id or permissions: those come from the manifest, which is read
  when the plugin is installed, and the reader approves them before it runs. A repo in the list whose manifest is
  wrong fails at install with every problem listed.
- **Plugin settings are edited on `/settings/plugins` only**, next to their plugin. `/settings` hides the `Plugins`
  group (`plugins`, and the site-only `plugins.default` and `plugins.blocked`), which had no widget anyway; the raw
  file still has them.
- **Signed out**, the page shows the site's defaults and Discover, and loads dev plugins; installing and turning a
  default off need an account (Phase 2: grants are rows).
- **The README line**: the repo has no top-level README, so the line heads `/plugins.md`, shows on
  `/settings/plugins` with the site's own address, and closes the hello example's README (with `<the site>`, as the
  domain isn't final).
- **No `check.mjs`** like Presio's: a manifest is checked, every problem listed, when it is installed and when it is
  loaded from localhost, which the guide's dev loop does before any release.

For later phases:

- Phase 4: add `scope.scores` and `scope.papers` to `METHOD_DOCS` in `server/agent/plugins-guide.ts` (its unit test
  fails until every `HOST_METHODS` entry has a line), and the score and bulk routes to the guide's "Data routes".
- Phase 5: a new permission (`identity`) appears in the guide's table and `/settings/plugins` by itself; the guide's
  last paragraph of "Data routes" is where the backend pattern and its example go.
- Phase 6: score standing is published by tagging `v0.1.0` and adding the topic; it then shows under Discover.

Checks: typecheck, lint and `next build` pass. Unit tests: 379 pass (7 new in `tests/unit/plugin-discovery.test.ts`:
versions and releases, discovery's search, cache, stale list and token, and the guide). Integration: 274 of 281
pass, 3 new in `tests/integration/plugins.test.ts` (installing the newest release, updates with and without new
permissions and an agent refused `approve`, re-pinning a site default for one reader, and the discover route). The 7
failures are the same as before this phase: six in `pdf-ingest.test.ts` (no poppler) and one in `follows.test.ts`.
`page-git.test.ts`'s fast-check merge property failed once in a full unit run and passed on rerun, as in pages
Phase 1. These ran against this worktree's own database, `potentialpaper_test_plugins3`, through an untracked `.env`.

### Phase 4: data for plugins, A and B (2026-11-16, branch `plugins-phase-4`)

Built:

- **A, `scope_stats`** (`server/scope-stats.ts`, `lib/scope-stats.ts`, migration `0036_scope_stats.sql`):
  - One row per `(scope, venue, field)`, for every field a venue's review forms mark `score` (the form's `summary`
    first, then its order). Each holds the submissions' means over their reviews, sorted, and the count. It also
    holds the form's `min`/`max`, 20 fixed-width bins between them (or between the means' own whole range when the
    form gives none), the same split by outcome, `decisions_out` and `computed_at`. Rolled up through
    `page_ancestors`, so a series has its editions' venues, each apart.
  - **Which submissions count:** every submission of the scope's member papers. A paper that is a member through a
    submission (a venue's) counts only its submissions to the venues the scope answers to, so NeurIPS doesn't show
    up on ICLR's page. A category or org gets every venue its papers went to.
  - **When it runs:** the `reviews` and `members` consumers mark the affected scopes and every scope above them,
    inside the transaction that changes their rows (`markPaperScopes`/`markScopes`). A paper's scopes are marked
    before and after, so a scope it leaves is recomputed too. Marking writes `scope_state`: `changed_at`, plus a
    `due_at` 5 s ahead that later marks push back, but never past `dirty_since` plus a minute. The worker runs
    `recomputeDueScopes` after each pass of the consumers (`WorkerOptions.tasks`, `WORKER_TASKS`), and its sleep
    shortens to the next due time. Each scope is taken with a 5-minute lease and released only if nothing marked it
    meanwhile. Recomputing replaces the scope's rows from the tables, so it is idempotent.
  - **The `scope-stats` consumer** only marks: a paper's scopes on any commit, which keeps `changed_at` moving when
    a title changes, or the scope itself. Its `reset` empties the statistics and marks every scope, so
    `consumers:rebuild -- scope-stats` rebuilds it. On a database migrated past `0036`, the worker starts this new
    consumer from zero by itself.
- **Routes** (public, `Cache-Control: public, max-age=60`):
  - `GET /api/v1/pages/{identifier}/scores` gives the venues and fields with counts per outcome, venues with the
    most submissions first.
  - `GET /api/v1/pages/{identifier}/scores/{venue}/{field}` (the venue's id URL-encoded) gives the sorted values,
    bins, `split` by outcome and `computedAt`.
  - Both send an ETag (a hash of the body) and answer `If-None-Match` with a 304 (`respondCached` in
    `server/api/http.ts`).
  - A page of a kind that has no papers gets a 422. An unknown field gets a 404.
- **B:** `GET /api/v1/pages/{identifier}/papers?fields=submissions,scores,status[&limit=&after=]` streams NDJSON.
  - Each line is one paper: identifier, address, title and year, then every submission with venue, number and
    link; `status` adds status and decision, and `scores` adds each review's score vector with its signature,
    licence and link.
  - Without `limit`, the whole scope streams in chunks of 500 (keyset by page id). With `limit`, one chunk, and
    the cursor for the next in `X-Next-Cursor`.
  - Gzipped with `CompressionStream` when asked (Next's compression leaves a response with `Content-Encoding`
    alone), with `Link: <CC BY 4.0>; rel="license"`.
  - ETagged on the scope's `changed_at`, the fields and the cursor.
- **RPC:** `scope.scores` and `scope.papers` (permission `scope.read`) are in `HOST_METHODS` and `host.ts`.
  - `scope.scores(identifier, venue?, field?)` gives the list, the list for one venue, or one field.
  - `scope.papers` gives one chunk (`{ rows, next }`, up to 2,000) through a new `HostServices.apiLines`, which
    `PluginFrame` implements by reading the NDJSON and the cursor header.
  - The SDK's `pp.scope.papers(identifier?, { fields, chunkSize, onChunk })` follows the cursor to the end, and
    resolves with every row, or streams them to `onChunk`.
  - `pp.d.ts` has the types (`ScoreList`, `ScoreField`, `BulkPaper`).
- **`plugins.venueStats.hideUntil`** is a site-only setting, `never` (the default) or `decisions`. With
  `decisions`, a venue whose decisions aren't out has `hidden: true`: no values, zeroed bins and split, the counts
  kept. This applies on the routes, the RPC and the venue page.
- **The venue page's `scores` panel** (`venue.main`, after `editions`; in `lib/panels.ts`, so it can be hidden and
  moved). `venueScoreStats` fills the place pages Phase 2 left. Per venue (several on a series), it shows:
  - the first score field as a histogram stacked by outcome, with a hover title per bar, an accessible name that
    summarises it, and a legend with counts;
  - a table of every field: range, submissions, median, middle half, and the medians of accepted and rejected
    submissions once there are decisions;
  - when hidden, a line saying they show once decisions are out.

  It reads quartiles and per-outcome medians in SQL, not the values.

- **`page.hasScores` on a scope** is now exact: the scope has score statistics.
- **Docs:**
  - `/plugins.md` has both methods (`METHOD_DOCS`) and the three routes under "Data routes", with ETags,
    `hideUntil`, the licence and the OpenAPI link.
  - `llms.txt` names the routes and `/openapi.json`, and there is an `/agent/updates` notice.
  - **`/openapi.json`** (`server/api/openapi.ts`) is a minimal OpenAPI 3.1 description of the public page routes
    (summary, files, members, submissions, venue-papers, scores, the field, papers). Its response bodies are made
    from the same zod schemas the routes check, so they can't drift.
  - DESIGN.md §4.3 (venue pages), §4.9 (consumers that depend on other consumers) and §10 (A and B), and
    IMPLEMENTATION.md Milestone 8 and "Pages above the paper", are updated.

Calls I made where the plan left room:

- **Chained, not a second reader of events.** The plan offered either. Reading events alone races the other two
  consumers, since each has its own cursor. Marking inside their transactions guarantees a recompute after the data
  changed, and the debounce coalesces an import.
- **Outcomes:** `desk_rejected` counts as rejected. `under_review` and no status count as `pending`. The plan
  named four groups.
- **Decisions are "out"** when any submission at the venue (venue-wide, not only the scope's) is accepted or
  rejected. Desk rejections come before decisions, so they don't count.
- **The open question, settled:** `plugins.venueStats.hideUntil`, defaulting to `never`, applies to A (routes,
  RPC, venue panel). It doesn't apply to B or to `reviews.forPaper`: those are the raw public reviews, shown on
  every paper page anyway, and the setting withholds the site's own ranking, not the data. The counts stay visible
  when hidden.
- **Bins are 20 between the form's `min`/`max`**, with the last bin closed. Values outside go to the nearest end.
  Each outcome's bins share the field's range, so they stack.
- **B lists every submission of a paper**, not only those to the scope's venues, so a plugin sees "rejected at
  NeurIPS, accepted at ICLR". A counts only the scope's venues, as above.
- **B's ETag is the scope's `changed_at`,** not a hash of the stream, so a 304 needs no work. It moves on any member
  paper's commit and on membership changes. It does not move on changes that make no commit (a paper identifier
  added by an import's lookup).
- **Only fields the forms mark `score` count,** as the plan says. On a paper, `page.hasScores` still infers
  numeric fields (`scoreTable`), so a venue imported without forms has scores on its papers but no statistics. The
  OpenReview import writes forms, so this is theoretical. `plugins.test.ts`'s page-routes test now commits forms.
- **The venue id is the `venues` id** (`openreview:ICLR.cc/2027/Conference`), URL-encoded as one path segment like
  identifiers. A venue page can have several sources, and tracks have no page yet. The list gives each venue's
  name.
- **Score parsing in SQL** follows `scoreOf`: a JSON number as it is, text by its leading number (`"6: marginally
above"`).
- **Performance:** I timed it on a synthetic ICLR-sized venue (40k submissions, 4 reviews each, 5 score fields).
  - A recompute takes about 4 s. The scores are extracted in a materialized CTE before grouping, and `work_mem` is
    raised to 128 MB inside the recompute's transaction. The first version took about 10 s, with sorts spilling
    the note content to disk.
  - With the one-minute cap, a scope under a continuous import is recomputed at most once a minute.
  - The bulk stream of the same 40k papers took about 8 s.
  - The seam, if this grows: recompute one venue of a scope rather than all of them, or keep per-submission means
    in a table the review projection writes.

For later phases:

- Phase 5: `network` and the consent prompt are as Phase 2 left them. The guide's "Data routes" now ends with the
  licence and OpenAPI paragraph, and the backend pattern goes after it. `/openapi.json` can grow to cover
  `/.well-known/jwks.json` and whatever a backend calls.
- Phase 6 (score standing):
  - Take the venue's first field from `pp.scope.scores(scope).scores` (already in form order).
  - Then call `pp.scope.scores(scope, venue.id, field)`. `values` is the curve's input, `bins` the histogram's,
    `split` the per-outcome version. `decisionsOut` drives `splitByDecision: auto`.
  - A paper's own mean comes from `reviews.forPaper` (or B's score vectors), averaged as `scoreTable` does.
  - Cache by ETag: the browser's HTTP cache already revalidates within the minute, and the plugin can keep its own
    copy in IndexedDB keyed by `computedAt`.
  - The org view needs `page_members` for orgs (pages Phase 4); the statistics roll up already.
- Moving a built-in panel onto the plugin API (Milestone 8) can now use these routes.
- The venue page is cached for 5 minutes (pages Phase 1), so its `scores` panel lags the statistics by up to that.

Checks: typecheck, lint and `next build` pass. Unit tests: 386 pass (7 new: `tests/unit/scope-stats.test.ts`, and
`scope.scores`/`scope.papers` with the SDK following the cursor in `tests/unit/plugins.test.ts`). Integration: 279 of
286 pass, 5 new in `tests/integration/scope-stats.test.ts` (statistics, roll-up and the venue panel's numbers;
marking, debounce and rebuild; ETag and 304; `hideUntil`; the bulk stream with fields, gzip, ETag and chunks). The 7
failures are the same as before this phase: six in `pdf-ingest.test.ts` (no poppler) and one in `follows.test.ts`.
These ran against this worktree's own database, `potentialpaper_test_plugins4`, through an untracked `.env`.

### Phase 6: score standing, paper and venue views (2026-11-17, branch `plugins-phase-6`)

Built:

- **The repo**, `github.com/benedict-armstrong/potentialpaper-score-standing`: public, MIT, topic
  `potentialpaper-plugin`, tagged `v0.1.0`. Vite 8 and TypeScript 7, `dist/` committed with unhashed file names (a
  commit already pins them), so a rebuild of unchanged code changes nothing. CI (GitHub Actions) runs typecheck, tests
  and the build, and fails if `dist/` differs from a fresh build. `npm run dev` rebuilds on change and serves the repo
  with CORS on `http://localhost:5175/` for "Load from localhost". No host code of its own: it loads the SDK from
  `https://ppusercontent.com/sdk/v1/pp.js` and keeps a copy of `pp.d.ts`.
- **The manifest** (`benedict-armstrong/score-standing`): permissions `reviews.read` and `scope.read`, no network.
  One panel, `standing`, `kinds: [paper, venue, org]`, `slot: { paper: aside, "*": main }`, `when: page.hasScores`.
  Settings `view` (`both`/`histogram`/`curve`), `field` (a string, empty is the venue's first) and
  `splitByDecision` (`auto`/`on`/`off`). The host's validator passes it with no errors and no warnings.
- **The figure** (`src/`):
  - `distribution.ts`, ported from acceptodds: `quantile`, `bandwidth`, `density`, `rootScaled`, `countBelow`,
    `niceTicks`, `percentAhead`, `standingBand`, `yAt`, plus `latticeGap` and `modes`.
  - `standing.ts`: settings read leniently, the field (the setting's if the venue has it, else the first), the split
    (`auto` = `decisionsOut`), the paper's mean as the site takes it (`scoreOf`'s leading-number rule, each review
    that scores the field counted once), its bin, its standing and band, and the text summary.
  - `figures.ts`: (a) the histogram's bars, stacked by outcome when split; (b) the curve, a kernel density over the
    form's range, root-scaled, split into per-outcome layers.
  - `render.ts`: both as SVG, ported from `VenueStanding` and `StandingChart`. The paper's bin is marked and the part
    of the field below it shaded; a line at the paper with its band ("This paper, Top 12%"). Hover, or focus and arrow
    keys: a bar's range, count and share (and its outcomes and accept rate when split); on the curve "N papers below"
    and, split, the accept rate at that score. Each figure is `role="img"` with an accessible name, described by a
    screen-reader summary (field, venue, count, median, the paper's mean and place, outcomes and accept rate); the
    tooltip is a polite live region.
  - `main.ts`: on a paper, `reviews.forPaper` and `scope.scores` of each of its venue scopes; a tab per submission
    whose venue has statistics, oldest first, opening on the accepted one (else the latest). On a venue or org, the
    scope's own `scope.scores`, a tab per venue (a series: one per edition). A field switcher (`<select>`) when the
    venue has more than one score field; it sets the `field` setting. A note instead of a figure when the site
    withholds the numbers (`hidden`, `plugins.venueStats.hideUntil`).
  - `cache.ts`: each field fetched is kept in the plugin's own IndexedDB, stamped with its `computedAt` (50 at most,
    oldest dropped; memory where IndexedDB is unavailable).
  - Theme: colours are the host's tokens (`--pp-*`), so it follows light and dark; it redraws at the frame's width.
- **Tests in the plugin repo** (31, vitest): the maths, including simulated ICLR-sized venues (scale
  {1, 3, 5, 6, 8, 10}, 1, 3, 4 or 3–5 reviews each) whose curve has one mode where Silverman's rule alone draws
  several, and a real second mode kept; the models; the cache; and the panel end to end in happy-dom against a fake
  `pp` (the calls on a paper and a venue, tabs, the caption, aria labels and summary, the field switch writing the
  setting and the second visit served from the cache, `view` and `splitByDecision`, the hidden note).
- **In this repo:** `tests/integration/score-standing.test.ts` installs the real plugin from GitHub
  (`PLUGIN_NETWORK_TESTS=1`; skipped otherwise): newest release, consent for its two permissions, its settings'
  defaults and a bad value refused, `dist/index.html` and its assets served from its own origin with the SDK allowed
  by the CSP and its sources not served, where its panel shows (paper `aside`, edition and series `main`, not on a
  category, not on an org without members), and the data it reads (the venue page's list names the venue the paper's
  submission names, rating first; the field's sorted means and split). DESIGN.md §10 ("The model") and
  IMPLEMENTATION.md Milestone 8 note it.

Calls I made where the plan left room:

- **`org` is declared.** It is harmless now: an org's `page.hasScores` is "it has score statistics", and an org has
  no members until pages Phase 4, so the panel never shows on one (the integration test checks it). Until the org
  view is built, on an org it draws what it draws on a venue: the org's own papers' distribution per venue, which is
  honest if not the plan's figure.
- **The bandwidth for discrete scores:** Silverman's rule, but never narrower than 0.8 × the widest gap between
  neighbouring values among those that hold 90% of the submissions (`latticeGap`), and at least 1/40 of the range.
  Two equal kernels `d` apart dip at `h < d/2`; unequal neighbours (a rare value between two common ones) needed more,
  and at 0.6 simulated venues still showed spurious modes. Below about a thousand submissions, a second bump is
  sometimes sampling noise, and is left alone.
- **The split curve** keeps the root scale: the total curve's height is divided between outcomes in proportion to
  each outcome's kernel density there, so the accepted layer's share of the height is the accept rate at that score,
  and the layers add up to the curve. **The split histogram** stacks bars by outcome; the paper's bin is outlined
  rather than filled, and the region below it is shaded behind the bars.
- **Colours:** accepted in `up`, rejected in `muted`, withdrawn in `faint`, pending in `rule`. The site's `down` is
  its `accent`, which marks the paper, so rejected doesn't use it.
- **Finding a paper's venue statistics:** a paper's scopes are its edition pages (direct `page_members`), so the
  plugin lists `scope.scores` for each scope of kind `venue` and matches the list's `venue.id` to each submission's.
  A submission at a venue with no page (a track, TMLR) gets no tab. No host change was needed.
- **Caching by `computedAt`, not ETag:** the RPC doesn't expose headers. The list call (small) is made on every
  page and says each field's `computedAt`; the values (up to ~40k numbers) are fetched only when that changes. The
  browser's HTTP cache under the host's `fetch` revalidates within the minute as well.
- **Standing** counts strictly below (ties are not beaten), rounds down (`percentAhead` over the rest of the field),
  and counts the paper in the field even if the statistics are a few seconds behind its reviews.
- **The field switcher writes the global `field` setting**, so the next paper opens on the same field; a venue
  without it falls back to its first. `view` and `splitByDecision` are changed on `/settings/plugins` only; the panel
  has no toggle for them.
- **No `$schema` in the manifest**, since the site's domain isn't final; the README doesn't link this repo, which is
  private.
- **The network test is opt-in**, so the suite doesn't depend on GitHub; I ran it (it passes against `v0.1.0`).

What the org view will need (for the phase after pages Phase 4):

- `page_members` for orgs, so `page.hasScores` is true on one and `scope.scores(org)` lists its venues and fields
  (the statistics roll up already).
- **The venue's whole distribution, not the org's:** from an org's `ScoreSummary.venue.id` the plugin has no way to
  the venue's page. Either `ScoreSummary` carries the venue's page identifier, or `page.resolve` accepts a venue id
  (`openreview:ICLR.cc/2027/Conference`, through `page_scope_names`). Then `scope.scores(<venue page>, venue, field)`
  gives the field the curve is drawn from.
- **The org's papers as named marks** (acceptodds' `marks`): A gives means without names. Either the field route
  grows an optional list of a scope's members with their means (`{ identifier, title, mean }`, for scopes up to some
  size), or the plugin reads B (`scope.papers(org, { fields: ['scores'] })`) and averages each paper's score
  vectors itself. The plan says "data comes from A only", so the first is the cleaner fit.
- In the plugin: open circles on the curve at each mark (`yAt`), named on hover within a few pixels, as
  `StandingChart` does; the venue view otherwise.

For later phases:

- v0.2 of the plugin: the org view (above), and before/after rebuttal, which needs a `reviews.history` RPC in the host.
- `plugins.default` is still open; score standing is a candidate.
- Discovery will list the repo once GitHub's search indexes its topic.

Checks: typecheck, lint pass. Unit tests: 386 pass (nothing changed in them). Integration: 280 of 287 pass, with the
new test run by `PLUGIN_NETWORK_TESTS=1`; the 7 failures are the same as before this phase: six in
`pdf-ingest.test.ts` (no poppler) and one in `follows.test.ts`. These ran against this worktree's own database,
`potentialpaper_test_plugins6`, through an untracked `.env`. The plugin repo: 31 tests, typecheck and build pass,
and CI is green on `main` and on the `v0.1.0` tag.

### Phase 5: plugins with their own backend, D (2026-11-17, branch `plugins-phase-5`)

Already in place from Phase 2, and left as it was: `network` origins go into the plugin's CSP `connect-src`
(`pluginCsp`), the consent prompt lists them, and a new origin asks again (`missingConsent` compares the grant's
`network`). Built:

- **The `identity` permission** (`PERMISSIONS`, so it appears in the prompt, `/settings/plugins` and the guide's table
  by itself): "Tell its own backend who you are: your handle, in a short-lived token signed by this site that only
  this plugin's backend accepts". A manifest asking for it with no `network` gets a warning.
- **Tokens** (`server/plugins/identity.ts`): ES256 JWTs, `kid` the key's RFC 7638 thumbprint, claims `iss` (the site's
  origin), `aud` (the plugin id), `sub`, `handle`, `plugin`, `iat`, `nbf` (−30 s), `exp` (+300 s) and `jti`.
  - `sub` is pairwise: `p_` + an HMAC of the account and plugin ids, keyed by `PLUGIN_SUBJECT_SECRET` or, without it,
    `BETTER_AUTH_SECRET`. It is stable across handle changes and differs per plugin.
  - `POST /api/v1/me/plugins/identity` `{ plugin, dev? }` needs a browser session (`requireSession`), and the plugin
    must be installed, `ready`, ask for `identity` and have it approved. Answers are `no-store`.
  - A plugin loaded from localhost (`dev: true`) gets `aud: "dev:<id>"` and `dev: true`, with no install check.
- **The RPC:** `identity.token` (permission `identity`) in `HOST_METHODS`, `HostServices.identityToken`. `PluginFrame`
  asks the route and keeps a token per plugin while it has over a minute left. Signed out, it fails with
  `Unavailable`; a 403 becomes `PermissionDenied`. The SDK has `pp.identity.token()` and `pp.identity.fetch(url,
init)`, which adds `Authorization: Bearer …`. `pp.d.ts` has `IdentityToken`.
- **Keys:** table `identity_keys` (migration `0040`), the private and public JWKs. The first key is made on first use.
  The newest unretired key signs, and every unretired key is served at **`/.well-known/jwks.json`** (public, CORS
  `*`, cached five minutes). `npm run identity:keys [-- rotate | retire <kid>]` manages them; retiring the last key is
  refused.
- **`identity` is personal** (`PERSONAL_PERMISSIONS` in `lib/plugins/installed.ts`): a site default that asks for it
  runs (status `ready`) with `missing.permissions: ["identity"]` until the reader approves it. `runningPermissions`
  gives what the frame's calls are checked against. The panel shows a short approval prompt above the frame
  (`ConsentPrompt personal`), and `/settings/plugins` offers Approve and Withdraw for it.
- **The manifest's `bot`** (a handle, optional). `GET /plugins/installed` gives each plugin `bot: { handle, known,
grants }` from `accounts` (`is_bot`) and `bot_grants`. The consent prompt and `/settings/plugins` say "Shows data
  that the bot @x writes on pages, which this site lets it write to `<pattern>` on <kind> pages", or that the site
  has no such bot (`components/plugins/BotNote.tsx`).
- **The example:** `examples/plugins/notes`, a reader's private notes on any page, kept by its own backend.
  `examples/plugins/notes-backend` holds `server.mjs` (Node, no dependencies) and `verify.mjs`. `verify.mjs` checks
  the signature, `alg`, `iss`, `aud`, `exp` and `nbf` with Node's crypto, and fetches the JWKS again on an unknown
  `kid`: once per kid a minute, and at most once a second. The integration test verifies the site's tokens with
  this same file.
- **Docs:** `/plugins.md` has "Your own backend" (`network`, `identity` and verifying it, with a `jose` snippet, the dev
  audience, and writing to pages as a bot), the `bot` field and `identity.token` in the method table. `/openapi.json`
  has `/.well-known/jwks.json`. There are `llms.txt` and `/agent/updates` lines, DESIGN.md §10 (data for plugins D,
  consent, the methods), IMPLEMENTATION.md Milestone 8, DEPLOY.md ("Plugins' identity keys", rotation) and
  `PLUGIN_SUBJECT_SECRET` in both env examples.

Calls I made where the plan left room:

- **ES256, not EdDSA:** every JWT library verifies it, and Node signs it with no dependency.
- **Keys live in Postgres, made on first use**, rather than in an env var, so there is nothing to set up and rotation
  is a script. The private key sits in the database beside everything else the site trusts.
- **A pairwise `sub`, plus the handle.** The plan says "naming the user". The handle names them, as the prompt says.
  `sub` gives backends a stable key that survives a handle change and can't join users across plugins. Account ids
  stay private.
- **Five-minute tokens**, with no refresh tokens: the frame asks again, and the host's cache keeps that cheap.
- **Only the reader can give `identity`.** Telling a third party who someone is isn't an admin's call, so a site
  default goes without it until each reader approves.
- **Only a browser session gets a token.** An agent's API token is refused: the frame's host asks for the token, and
  an agent acting as the person has no frame to ask for.
- **Dev tokens are minted for any id** but carry `dev:` in `aud`, so the published backend refuses them. The token
  still names the reader's handle to a localhost plugin the reader loaded themselves.
- **`bot` is informational and unverified.** No bot belongs to a plugin yet (registration is Milestone 7), so the
  prompt says what the plugin claims to show and what the site lets that bot write. It doesn't say the bot is the
  plugin's. Changing `bot` in an update doesn't ask for consent again, since it grants nothing.
- **Nothing from Milestone 7 was pulled forward.** No plugin needs bot registration, bot tokens or webhooks yet.
  Bots can still only be granted `reviews/<source>/**` (and kind files), so the guide calls `extensions/<plugin
id>/` reserved, not grantable.
- **The example's backend origin** (`https://notes.potentialpaper.example`) is a placeholder. The example runs for
  real only from localhost, and its README says to change it.

For later phases:

- Score standing's org view (Phase 6's list) is unchanged by this phase.
- Milestone 7 (bots for outsiders): a registration could tie a bot to a plugin id, so the prompt can say "its own
  bot". Grants of `extensions/<plugin id>/**` need `grantProblem` to allow them.
- A backend that wants the reader's consent for more (writing on their behalf) would need scoped tokens; nothing
  asks for that yet.
  Checks: typecheck, lint, prettier and `next build` pass (the build lists `/.well-known/jwks.json` and
  `/api/v1/me/plugins/identity`). Unit tests: 407 pass, 3 of them new in `tests/unit/plugins.test.ts`: the manifest's
  `identity` and `bot`; consent for `identity` on a site default and `runningPermissions`; and `identity.token` behind
  its permission, with the real SDK's `pp.identity.fetch` sending the bearer token. Integration: 305 of 313 pass, 1
  skipped (the network plugin test). The 7 failures are the same as before this phase: six in `pdf-ingest.test.ts` (no
  poppler) and one in `follows.test.ts`. 5 tests are new, in `tests/integration/plugin-identity.test.ts`, and each
  token in them is checked by the example backend's `verify.mjs`:

- an approved plugin's token: its claims, pairwise `sub` and JWKS, refused when the token is for another audience or
  issuer, forged or expired, and refused before approval;
- refusals: signed out, an agent's API token, a plugin not asking for `identity`, an uninstalled one, and the dev
  audience;
- a site default running without `identity` until the reader approves it;
- key rotation, with the verifier fetching the keys again, and retirement;
- the `bot` listing, for a known bot with its grants and for a person's handle.

These ran against this worktree's own database, `potentialpaper_test_plugins5`, through an untracked `.env`.

### Phase 6: score standing, the org view (2026-11-17, branch `plugins-phase-6-org`)

Built:

- **The host API, for every plugin** (`server/scope-stats.ts`, the field route, `host.ts`, the SDK):
  - **From a venue id to its page:** every `ScoreSummary.venue` (the list and the field) carries `page`, the venue's
    own page summary, or `null` (`venuePagesOf`). That is the venue page whose `page_scope_names` hold the venue id
    (its `venue.json` `sources`), not merged, the deepest first. Its statistics of the venue are the whole venue's,
    where a category's or an org's are only its own papers'.
  - **Named means:** `GET /api/v1/pages/{identifier}/scores/{venue}/{field}?marks=true` adds `marks`, the scope's own
    submissions in that field, ascending by mean: `{ identifier, address, title, mean, outcome }`
    (`scopeScoreMarks`). The submissions and means are the statistics' own (the same `scopeSubmissionsSql` and score
    rule), read live from the tables. The field's `count` gates it: above `MAX_MARKS` (1,000), `marks` is `null`
    without a query. When `hideUntil` withholds the field, `marks` is `[]`. A bad value is a 400.
  - **RPC:** `scope.scores(identifier, venue, field, { marks: true })` (param `marks`, only with a field), in
    `pp.js` and `pp.d.ts` (`ScoreMark`, `venue.page`).
  - **Docs:** `/plugins.md` (the method's line and the field route, with how to draw a scope's papers on its venue),
    `/openapi.json` (the `marks` query, `venue.page` in the schemas, which are the routes' own zod), `llms.txt`, an
    `/agent/updates` notice, DESIGN.md §10 (A, and the plugin's line) and IMPLEMENTATION.md Milestone 8.
- **Score standing v0.2.0** (`github.com/benedict-armstrong/potentialpaper-score-standing`, tag `v0.2.0`, CI green on
  `main` and the tag, `dist/` committed):
  - On an org (`orgTabs`): a tab per venue the org's papers went to (the org's list, most submissions first).
  - Each tab's distribution comes from the venue's own page (`venue.page`). The panel asks that page's list for the
    venue (small, once per load) for its `computedAt` and `hidden`. It then fetches the field from there, and the
    org's field with `{ marks: true }`, both cached by `computedAt` as before.
  - The figure: open circles on the curve at each mark (`yAt`), and one above each histogram bar that holds marks,
    sized by how many. Hover names the marks within 6 px (title, mean, band, outcome; four, then "and N more"), with
    the "N papers below" readout. Up and down arrows step from one marked paper (or bar) to the next. A click or
    Enter on a named paper opens it (`ui.openUrl`).
  - Text: the caption says "N of <org>'s submissions among M at <venue>", and the accessible name adds "<org>'s N
    submissions marked". The screen-reader summary adds their count, median and band, and each paper, best first
    (ten).
  - A venue with no page of its own draws the org's own distribution, still marked. With over 1,000 marks, the
    venue is drawn with a note and no names. A withheld venue gets the note as on a venue page.
  - Paper and venue views are unchanged. `pp.d.ts` is the host's new copy. Tests: 38 (7 new: `orgTabs`,
    `placeMarks`, `marksNear`, `markText`, the summary; the org panel end to end, with the fake host now filtering
    a venue's list and answering marks, plus `ui.openUrl`, including the no-page, too-many and withheld cases).

Calls I made where the plan left room:

- **`venue.page` on the summary rather than `page.resolve` accepting venue ids.** The plugin has the summary in hand
  already, and so has any other plugin or backend reading the scores. `page.resolve` stays identifiers only, since a
  venue id isn't a page's identifier and would blur what that call promises.
- **Marks on the field route, not in `scope_stats`.** Storing a paper id beside each of ICLR's 40k means per field
  would grow every venue's rows for the sake of small scopes. Read live for one scope's submissions at one venue, it
  is one grouped query over at most 1,000 submissions, gated by the stored `count` before it runs. The live read can
  lag or lead the stored values by the few seconds of the debounce; the test checks they agree when caught up.
- **The cap is 1,000** (`MAX_MARKS`), beyond which names stop being readable on a 300 px curve anyway; `null` (not a
  truncated list) so a client never draws a misleading subset.
- **What a mark carries:** the paper's public identifier, address, title, mean and outcome, all public on the paper's
  page and the org's members route already. No author names: why a paper is an org's stays private (pages Phase 4).
- **A submission is a mark**, as it is a value in the statistics. A paper sent twice to one venue would be two marks;
  a paper at two venues shows on each venue's tab.
- **The histogram shows marks too**, as one circle per bar (the plan names only the curve). The two figures sit side
  by side, so a bar the org's papers fall in would otherwise read as unmarked.
- **The org's distribution is not drawn**, only the venue's with the marks, as the plan says; on a venue without a
  page the org's own is the only one there is.
- **The org view keeps `splitByDecision`**: the venue's curve splits by outcome as on its page, and each mark's
  outcome is in its name rather than its colour, so the circles stay one style (accent) in both themes.
- **The release is a minor version** with no new permission, so installed readers get "Update" without a new
  consent prompt.

For later phases:

- Phase 6's "Later": before/after rebuttal needs `reviews.history` in the host.
- `plugins.default` is still open; score standing is a candidate.
- Categories: score standing doesn't declare them, but `venue.page` and `marks` work on a category too, so a category view
  is a manifest line and `orgTabs` under another name, plus `page.hasScores` in `KINDS.category.contextKeys` (pages
  Phase 5's note).

Checks: typecheck, lint, prettier (`config/institution-ror.json` was unformatted before this phase) and `next build`
pass. Unit tests: 407 pass. The `scope.scores` case in `tests/unit/plugins.test.ts` now covers `marks` and its refusal
without a field. `page-git.test.ts`'s fast-check merge property failed once and passed on rerun, as before.

Integration: 306 of 314 pass, 1 skipped (the network test). The 7 failures are the same as before this phase: six in
`pdf-ingest.test.ts` (no poppler) and one in `follows.test.ts`.

- New in `tests/integration/scope-stats.test.ts`: an org with two printed addresses lists the venue with
  `venue.page`, the venue page gives the whole field, and `?marks=true` names the org's two submissions, agreeing
  with its `values`. On the edition, every submission is marked, and `marks=yes` is a 400. Above the cap gives
  `null`. A venue with no page gets none, and a withheld field gives `marks: []`.
- The test helper's route for the field now matches a query string.
- `PLUGIN_NETWORK_TESTS=1` `score-standing.test.ts` passes against `v0.2.0` from GitHub. It now checks the release's
  CSS has the marks, that the panel shows on an org with scored papers and not on one without, that the org's list
  names `venue:iclr/2027`, whose field equals the paper view's, and the org's two papers by name and mean.

These ran against this worktree's own database, `potentialpaper_test_plugins6org`, through an untracked `.env`. The
plugin repo: 38 tests, typecheck and build pass, and CI is green on `main` and on `v0.2.0`.

### Places: where panels sit, and the author section (2026-11-20)

- **Decided with Benedict:** plugins go anywhere on a page but the owners' section. A panel's `slot` is the place it
  prefers; readers move a `movable` one (the default) in `<kind>.panels.placement`. A paper's confirmed authors let
  panels into the author section with `author/plugins.json` (a file in the repo, not a table: the path rules already
  make `author/` theirs, and it has history). Listing a panel installs nothing; a reader sees it only with the plugin
  installed. Read-only, as everywhere. Papers only: other kinds' owners' sections wait for the shared page layout.
- **Places** (`lib/plugins/manifest.ts`): `main`, `aside`, `tab`, and on a paper `body`, `submission`, `community`
  (end of the Community section) and `author`. `panelPlace` says where a panel goes for a reader; `movablePlaces` the
  ones a reader may choose (never `author`). `paper.community` and `paper.author` are drawn inside their sections
  (`components/plugins/NestedPanels.tsx`); `paper.body` now takes plugins too.
- **`author/plugins.json`** (`lib/plugins/author-plugins.ts`): `{ "panels": [{ "panel": "<plugin>.<panel>",
"settings": {…} }] }`, up to 8, a file type (`authorPlugins`), projected to `page_current.author_plugins`
  (migration `0046`). The page passes it to the plugin context; each entry's `settings` reach the frame as
  `surface.config`.
- **Settings form:** a movable plugin panel's row in a kind's Panels list has a dropdown of places; the row moves to
  that part of the list.
- **Frames** know `surface.place` and `surface.size` (`{ width, height }`), and get `surface.resize` when it changes
  (`pp.ui.onResize` in the SDK).
- **Paper map v0.6.0:** the minimap prefers `community`, and draws taller in the main text than in the side column.
