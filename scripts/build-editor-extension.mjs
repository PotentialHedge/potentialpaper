// Bundles the site's VS Code extension, and copies the startup module (editors/vscode/boot.js), (editors/vscode/extension) into the web editor's files, beside the
// VS Code build: public/editor/vscode/<version>/potentialpaper/. Run by scripts/build-web-editor.sh and the
// Dockerfile.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
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
for (const file of ['package.json', 'package.nls.json']) copyFileSync(join(source, file), join(out, file));
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
