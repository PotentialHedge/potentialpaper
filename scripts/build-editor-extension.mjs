// Bundles the site's VS Code extension (editors/vscode/extension), with the page files' JSON Schemas, its webviews'
// pages (the preview, with the site's stylesheet, and the PDF viewer, with PDF.js), and copies the startup module
// (editors/vscode/boot.js) into the web editor's files, beside the VS Code build:
// public/editor/vscode/<version>/potentialpaper/. Then packages the same extension for VS Code on the desktop,
// public/editor/potentialpaper.vsix. Run by scripts/build-web-editor.sh and the Dockerfile.
//
//   node scripts/build-editor-extension.mjs [--no-vsix]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { build } from 'esbuild';
import postcss from 'postcss';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = /VSCODE_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'src/editors/vscode/index.ts'), 'utf8'))[1];
const source = join(root, 'editors/vscode/extension');
const out = join(root, 'public/editor/vscode', version, 'potentialpaper');
const modules = join(root, 'node_modules');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });
mkdirSync(join(out, 'media/pdf'), { recursive: true });
// The startup module, beside the build it imports.
cpSync(join(root, 'editors/vscode/boot.js'), join(out, '..', 'boot.js'));
cpSync(join(source, 'package.nls.json'), join(out, 'package.nls.json'));
cpSync(join(source, 'README.md'), join(out, 'README.md'));
// The JSON Schemas of the page's files, made from the site's definitions (src/server/pages/schemas.ts), and the
// manifest's `jsonValidation` that points VS Code's JSON support at them.
execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/write-page-schemas.ts'), out], {
  cwd: root,
  stdio: 'inherit',
});
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
manifest.contributes.jsonValidation = JSON.parse(readFileSync(join(out, 'jsonValidation.json'), 'utf8'));
rmSync(join(out, 'jsonValidation.json'));
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// The extension, one bundle for both hosts: a web worker in the browser, Node on the desktop.
await build({
  entryPoints: [join(source, 'src/extension.ts')],
  outfile: join(out, 'dist/extension.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['vscode'],
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
});

// The webviews' pages.
await build({
  entryPoints: { preview: join(source, 'webview/preview.ts'), 'pdf/viewer': join(source, 'webview/pdf.ts') },
  outdir: join(out, 'media'),
  bundle: true,
  // Classic scripts: a webview's resources come from another origin through its service worker, without the CORS
  // headers a module script needs.
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
});

// The preview's stylesheet: the site's, compiled with nothing scanned (an empty base), so only the rules it
// defines and applies are in it.
const empty = mkdtempSync(join(tmpdir(), 'pp-preview-css-'));
const cssFrom = join(source, 'webview/preview.css');
const css = await postcss([tailwind({ base: empty, optimize: true })]).process(readFileSync(cssFrom, 'utf8'), {
  from: cssFrom,
});
rmSync(empty, { recursive: true });
writeFileSync(join(out, 'media/preview.css'), css.css);
cpSync(join(modules, 'katex/dist/katex.min.css'), join(out, 'media/katex/katex.min.css'));
cpSync(join(modules, 'katex/dist/fonts'), join(out, 'media/katex/fonts'), {
  recursive: true,
  filter: (path) => !/\.(ttf|woff)$/.test(path),
});

// PDF.js's stylesheet and what it loads as it needs it: fonts a PDF doesn't embed, character maps, decoders.
const pdfjs = join(modules, 'pdfjs-dist');
cpSync(join(pdfjs, 'web/pdf_viewer.css'), join(out, 'media/pdf/pdf_viewer.css'));
cpSync(join(pdfjs, 'web/images'), join(out, 'media/pdf/images'), { recursive: true });
cpSync(join(source, 'webview/pdf.css'), join(out, 'media/pdf/viewer.css'));
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
  cpSync(join(pdfjs, dir), join(out, 'media/pdf', dir), { recursive: true });
cpSync(join(pdfjs, 'LICENSE'), join(out, 'media/pdf/LICENSE'));
console.log(`extension → ${out}`);

// The same extension for VS Code on the desktop (and VS Codium, Cursor…), as a file to install.
if (!process.argv.includes('--no-vsix')) {
  const vsix = join(root, 'public/editor/potentialpaper.vsix');
  // Without the proposed API the browser build turns on (the Commit button under the message box), which a
  // desktop VS Code doesn't allow an extension it didn't ship with, and the APIs the rest needs are years old.
  const desktop = mkdtempSync(join(tmpdir(), 'pp-vsix-'));
  cpSync(out, desktop, { recursive: true });
  const desktopManifest = { ...manifest, engines: { vscode: '^1.90.0' } };
  delete desktopManifest.enabledApiProposals;
  writeFileSync(join(desktop, 'package.json'), `${JSON.stringify(desktopManifest, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [
      join(modules, '@vscode/vsce/vsce'),
      'package',
      '--no-dependencies',
      '--allow-missing-repository',
      '--skip-license',
      '--out',
      vsix,
    ],
    { cwd: desktop, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  rmSync(desktop, { recursive: true });
  console.log(`desktop extension → ${vsix}`);
}
