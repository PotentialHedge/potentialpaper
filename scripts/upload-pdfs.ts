import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AwsClient } from 'aws4fetch';

/**
 * Copies a scrape's PDFs to R2, byte for byte, under their SHA-256, and records each in a manifest for
 * `attach-pdfs`. Only a paper whose note states a license is copied. Safe to stop and run again.
 *
 *   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… npm run papers:upload-pdfs -- \
 *     ../papermarket/research/data/iclr2027.sqlite ../papermarket/research/data/pdfs/openreview data/iclr2027.jsonl
 */
const BUCKET = process.env.R2_BUCKET ?? 'papertrail-pdfs';
const WORKERS = Number(process.env.UPLOAD_WORKERS ?? 8);
const ATTEMPTS = 6;

export interface ManifestRow {
  id: string;
  sha256: string;
  bytes: number;
  license: string;
  fetchedAt: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main() {
  const [corpus, dir, manifest] = process.argv.slice(2);
  if (!corpus || !dir || !manifest) throw new Error('usage: papers:upload-pdfs <sqlite> <pdf dir> <manifest>');
  const client = new AwsClient({
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    service: 's3',
    region: 'auto',
  });
  const base = `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${BUCKET}`;

  const done = new Set(
    existsSync(manifest)
      ? readFileSync(manifest, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as ManifestRow).id)
      : [],
  );
  const sqlite = new DatabaseSync(corpus, { readOnly: true });
  const notes = sqlite.prepare("select id, raw ->> '$.license' as license from submissions").all() as unknown as {
    id: string;
    license: string | null;
  }[];
  sqlite.close();
  const queue = notes.filter(({ id, license }) => license && !done.has(id) && existsSync(join(dir, `${id}.pdf`)));
  console.log(`${notes.length} notes, ${done.size} done, ${queue.length} to upload`);

  let uploaded = 0;
  let bytesSent = 0;
  let failed = 0;
  const started = Date.now();

  async function upload({ id, license }: { id: string; license: string | null }) {
    const path = join(dir, `${id}.pdf`);
    const body = readFileSync(path);
    if (body.subarray(0, 4).toString() !== '%PDF') throw new Error('not a PDF');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const url = `${base}/pdf/${sha256}.pdf`;
    const head = await client.fetch(url, { method: 'HEAD' });
    if (head.status !== 200) {
      const put = await client.fetch(url, {
        method: 'PUT',
        body,
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
      if (!put.ok) throw new Error(`HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
      bytesSent += body.length;
    }
    const row: ManifestRow = {
      id,
      sha256,
      bytes: body.length,
      license: license as string,
      fetchedAt: statSync(path).mtime.toISOString(),
    };
    appendFileSync(manifest, `${JSON.stringify(row)}\n`);
    uploaded += 1;
    if (uploaded % 200 === 0) {
      const seconds = (Date.now() - started) / 1000;
      console.log(
        `${uploaded}/${queue.length}, ${(bytesSent / 1e9).toFixed(1)} GB, ${(bytesSent / 1e6 / seconds).toFixed(1)} MB/s, ${failed} failed`,
      );
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      while (next < queue.length) {
        const note = queue[next++];
        for (let attempt = 1; ; attempt += 1) {
          try {
            await upload(note);
            break;
          } catch (err) {
            if (attempt === ATTEMPTS) {
              failed += 1;
              console.error(`${note.id}: ${String(err)}`);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
          }
        }
      }
    }),
  );
  console.log(`uploaded ${uploaded}, failed ${failed}, sent ${(bytesSent / 1e9).toFixed(1)} GB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
