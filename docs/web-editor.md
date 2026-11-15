# The web editor

A paper's page is a git repository (`docs/git.md`), and it is edited as one. The "edit" button under a paper's
title opens a dialog (`src/components/paper/EditDialog.tsx`) with two ways in:

- **In the browser:** `/code/<paper>` (`src/app/code`), the page's files in a web editor, with a preview of each
  section beside it, rendered the way the page renders it.
- **With git:** `git clone` over HTTPS (and SSH, once it is open), then push (`docs/git.md`).

Both commit through `commitPage`, so both are held to the same rules (`src/server/pages/rules.ts`, `check.ts`).

The web editor is **VS Code for the Web**, built from the MIT-licensed sources, with an extension of our own. It
is kept behind a small contract, so it can be replaced without touching the rest of the site.

## The contract

An editor gets two things from the site, and nothing else.

### 1. The workspace API (`src/server/workspace.ts`)

| Request                                       | What it does                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/workspace?scheme&value`          | The files at the head: each one's path, blob id, text (inline up to 2 MB in all), Git LFS target (`lfs`), and `readonly` (why this viewer can't change it, or `null`). Also `head`, `signedIn`, `areas` (where the viewer may add files) and the clone addresses. Anyone may read.         |
| `GET /api/v1/workspace/blob?scheme&value&oid` | One blob, by id. Immutable.                                                                                                                                                                                                                                                                |
| `POST /api/v1/workspace/commit`               | `{ paper, baseOid, changes: [{ path, content \| null }], message }`. `baseOid` is the head the editor loaded: changes made since are merged in. `message` is a git message: first line the summary, `Evidence: <url>` trailers last. `409 edit_conflict` when both changed the same lines. |
| `POST /api/v1/workspace/rebase`               | `{ paper, baseOid, changes }`: the changes moved onto the head without committing, merged, with git's conflict markers where both changed the same lines. Each file comes back with `original` (the head's text) and `conflict`. What an editor does after a 409.                          |
| `POST /api/v1/workspace/files`                | Multipart `file`, `scheme`, `value`, `path`: stores a PDF or picture for a Git LFS path (`thumbnail.png`, `versions/<id>.pdf`) and answers with the pointer to write at that path.                                                                                                         |
| `POST /api/v1/pages/render`                   | `{ content, format }`: a section as the page renders it. The host page's preview uses it.                                                                                                                                                                                                  |

Requests are same-origin, so the reader's session signs them.

### 2. A frame on the host page (`src/editors/types.ts`, `channel.ts`)

An editor is a `WebEditor` (`src/editors/types.ts`): a page at `frameSrc(paper)`, same-origin, which `/code/<paper>`
frames. It talks to the host page over a `BroadcastChannel` named `potentialpaper-editor:<scheme>:<value>`
(`src/editors/channel.ts`):

- from the editor: `ready`; `active` (the open file's path and text as typed, for the preview); `committed`;
- from the host page: `hello` (send `active` again); `open` (open a file).

## Swapping the editor

Add a folder beside `src/editors/vscode/` with a `WebEditor` and whatever serves its frame, speak the API and the
channel above, and name it in `src/editors/index.ts`. Delete `src/editors/vscode`, `editors/vscode`,
`src/app/editor/vscode`, the `vscode` stage of the `Dockerfile`, `scripts/build-web-editor.sh`,
`scripts/build-editor-extension.mjs` and the `/editor/` rules in `next.config.ts`. Nothing else knows it is VS
Code.

## VS Code for the Web

- **Build:** `npm run editor:build` (`scripts/build-web-editor.sh`) builds VS Code at the tag in
  `src/editors/vscode/index.ts` in the `Dockerfile`'s `vscode` stage, from source, with no marketplace and no
  telemetry, and copies it to `public/editor/vscode/<version>/` (gitignored). The first build takes ~15 minutes;
  Docker caches it after. Then it bundles the extension into `…/<version>/potentialpaper/`
  (`npm run editor:extension` does only that, after changing the extension). The production image does both.
- **The frame:** `/editor/vscode?scheme&value` (`src/app/editor/vscode/route.ts`, `src/editors/vscode/workbench.ts`)
  is the build's `workbench.html` with its configuration: the page repo as the folder `potentialpaper://page/`, the
  extension added to the built-in ones, auto-save on, light theme, AI features off.
- **Trimmed:** `editors/vscode/patch-vscode.mjs` patches the sources before the build: no terminal, Run and Debug,
  Ports, Remote or Extensions views (hidden from the activity bar and panel; the services stay, as much of the
  workbench asks for them), no Run or Terminal menus, and no GitHub/Microsoft sign-in, notebook, npm, simple
  browser or prompt-file extensions. Settings in `workbench.ts` hide Accounts, the secondary side bar, the
  layout controls and the debug toolbar; the extension binds the terminal/debug/extensions keys to nothing. Their
  commands are still in the command palette.
- **Schemas:** the JSON files of a page (links, versions, `thumbnail.json`, `pdf.json`) are checked as they're
  typed against JSON Schemas made from the zod definitions the site checks them with
  (`src/server/pages/schemas.ts`; `z.toJSONSchema`). `scripts/write-page-schemas.ts` writes them into the
  extension with its `jsonValidation` when it is built (VS Code's JSON support ignores `json.schemas` set as a
  default); the site serves the same at `/schemas/<name>.json` for `prek.toml` and other editors.
- **Before a commit** (the extension's `precommit.ts`), what `prek.toml` does in a clone: sections formatted with
  Prettier (the same version as the hook; also Format Document), JSON laid out as the site writes it, and no
  commit while a changed file has an error.
- **Sign-in:** `/code/…` sends someone signed out to sign in, and back.
- **Starter files:** a page with no repo yet shows the files its first commit starts with (`starter.ts`): empty
  sections and `prek.toml`.
- **The extension** (`editors/vscode/extension/`): a file system for the page repo (`store.ts`), which keeps saved
  changes in the browser until they are committed, with the commit they started from; Source Control, whose
  message box and ✓ commit; a 409 rebases the changes with conflict markers to settle. It posts the open file to
  the host page for the preview.
- **CSP:** the editor's frame and files have their own policy (`src/editors/vscode/csp.ts`), since VS Code runs
  workers from `blob:` and frames its extension host from this origin. The site's policy leaves `/editor/` out.
- **Webviews** (VS Code's Markdown and image previews) need an origin per webview: `{{uuid}}.<host>` with
  wildcard DNS and TLS (`WEB_EDITOR_WEBVIEW_URL`, a URL template ending in
  `/editor/vscode/<version>/out/vs/workbench/contrib/webview/browser/pre/`). Development uses
  `{{uuid}}.localhost`, which browsers resolve to the machine. Production has none yet (TODO.md), so those
  previews don't open there; the host page's own preview works without them.
