// Bundles the site's VS Code extension (editors/vscode/extension), with the page files' JSON Schemas, and copies the
// startup module (editors/vscode/boot.js) into the web editor's files, beside the
// VS Code build: public/editor/vscode/<version>/potentialpaper/. Run by scripts/build-web-editor.sh and the
// Dockerfile.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = /VSCODE_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'src/editors/vscode/index.ts'), 'utf8'))[1];
const source = join(root, 'editors/vscode/extension');
const out = join(root, 'public/editor/vscode', version, 'potentialpaper');

mkdirSync(join(out, 'dist'), { recursive: true });
// The startup module, beside the build it imports.
copyFileSync(join(root, 'editors/vscode/boot.js'), join(out, '..', 'boot.js'));
copyFileSync(join(source, 'package.nls.json'), join(out, 'package.nls.json'));
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
console.log(`extension → ${out}`);
