import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Poppler's command-line tools (`poppler-utils`): on this Mac through Homebrew, in the tools image by apt. */

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export async function pageCount(pdf: string): Promise<number | null> {
  const { stdout } = await run('pdfinfo', [pdf], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  const pages = /^Pages:\s+(\d+)/m.exec(stdout);
  return pages ? Number(pages[1]) : null;
}

/** Page 1's text, in `pdftotext`'s `raw` (content-stream order) or `layout` (as on the page) mode. */
export async function firstPageText(pdf: string, mode: 'raw' | 'layout'): Promise<string> {
  const { stdout } = await run('pdftotext', ['-f', '1', '-l', '1', `-${mode}`, '-enc', 'UTF-8', pdf, '-'], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  // Postgres text can't hold NUL.
  return stdout.replace(/\u0000/g, '');
}

/** Page 1 as a progressive JPEG whose longer side is `size` pixels. */
export async function renderFirstPage(pdf: string, size: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'cover-'));
  try {
    await run(
      'pdftoppm',
      [
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        '-scale-to',
        String(size),
        '-jpeg',
        '-jpegopt',
        'quality=72,progressive=y,optimize=y',
        pdf,
        join(dir, 'out'),
      ],
      { timeout: TIMEOUT_MS },
    );
    return await readFile(join(dir, 'out.jpg'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
