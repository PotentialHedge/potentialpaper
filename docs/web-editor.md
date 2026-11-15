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
| `POST /api/v1/pages/render`                   | `{ content, format }`: a section as the page renders it. The previews use it (the extension's and the host page's).                                                                                                                                                                        |

Requests are same-origin, so the reader's session signs them.

### 2. A frame on the host page (`src/editors/types.ts`, `channel.ts`)

An editor is a `WebEditor` (`src/editors/types.ts`): a page at `frameSrc(paper)`, same-origin, which `/code/<paper>`
frames. It talks to the host page over a `BroadcastChannel` named `potentialpaper-editor:<scheme>:<value>`
(`src/editors/channel.ts`):

- from the editor: `ready` (with `previews`: the editor shows sections as the page does itself, so the host page
  doesn't); `active` (the open file's path and text as typed, for the preview); `committed`;
- from the host page: `hello` (send `ready` and `active` again); `open` (open a file).

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
  browser or prompt-file extensions. Accounts is hidden by default (also the patch, as it is stored, not a setting). Settings in `workbench.ts`
  hide the secondary side bar, the
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
  the host page, for its preview where the extension can't show one.
- **The preview** (`preview.ts`): a panel beside the section in front, as the page will show it, following the
  section being edited and updating as it is typed (the editor title's button, Ctrl/Cmd+Shift+V, in place of VS
  Code's Markdown preview on sections). The site renders it (`/api/v1/pages/render`); its stylesheet is the
  site's `globals.css`, compiled into the extension with nothing scanned (`webview/preview.css`), with KaTeX's.
- **PDFs** (`pdf.ts`, `webview/pdf.ts`): a read-only custom editor for `*.pdf`, PDF.js's viewer component with
  its fonts, character maps and decoders in the extension, parsing on the page (a webview can't start a worker
  from its resources). The bytes come through VS Code, so in the browser from R2, in a clone from the disk; a
  file that is still a Git LFS pointer says so. The browser fetches PDFs from R2's public host, so that host answers CORS
  requests from anywhere: a CORS rule on the `papertrail-pdfs` bucket (GET and HEAD, any origin), and a response
  header transform rule on the `pdfs.` host that sets `Access-Control-Allow-Origin: *`, since Cloudflare's cache
  keeps one copy whatever the `Origin` and would otherwise serve one without the header. Both set 2026-11-15 in
  the Cloudflare dashboard's account and zone, not in this repo.
- **JSON files** get their schemas' errors, completion and hovers, and on an empty file a skeleton of the required
  fields (`defaultSnippets`, added by `scripts/write-page-schemas.ts` to the extension's copy only).
  **PotentialPaper: New Link** writes `links/NN-<slug>.json`.
- **CSP:** the editor's frame and files have their own policy (`src/editors/vscode/csp.ts`), since VS Code runs
  workers from `blob:` and frames its extension host from this origin. The site's policy leaves `/editor/` out.
- **Webviews** (the preview, the PDF viewer, VS Code's image preview) need an origin per webview: `{{uuid}}.<host>` with
  wildcard DNS and TLS (`WEB_EDITOR_WEBVIEW_URL`, a URL template ending in
  `/editor/vscode/<version>/out/vs/workbench/contrib/webview/browser/pre/`). Development uses
  `{{uuid}}.localhost`, which browsers resolve to the machine. Production has none yet (TODO.md), so those
  previews don't open there: the workbench sets `potentialpaper.webviews` off, so the extension shows neither, PDFs
  open as VS Code shows a file it can't read, and the host page shows its own preview beside the frame instead.

## VS Code on the desktop

The same extension works in VS Code on a computer (and VS Codium, Cursor…), on a `git clone` of a page: a folder
with the page's `prek.toml` at its root. `npm run editor:extension` also packages it as
`public/editor/potentialpaper.vsix`, served at `/editor/potentialpaper.vsix` and linked from the Edit dialog's
"With git" part; install it with Extensions → ⋯ → Install from VSIX, or `code --install-extension`. The `.vsix` is
built without the proposed API the browser build turns on, and needs VS Code 1.90.

There it has the preview, the PDF viewer, the JSON schemas, the section formatter and New Link; Source Control is
git's own, and `prek` runs the checks before a commit. The site's address comes from the clone's git remote
(`https://<host>/git/…`, or the SSH one's host without `git.`), or the `potentialpaper.origin` setting. The site
renders previews only for someone signed in, so the first preview asks for an API key from the profile
(**PotentialPaper: Sign In for Previews**), kept in VS Code's secret storage per site. JSON schemas apply by file
name (`links/*.json`, `thumbnail.json`…), as VS Code's `jsonValidation` can't ask which repo a file is in, so a
file with those names in another project is checked too.
