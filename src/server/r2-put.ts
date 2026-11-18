import { request } from 'node:https';
import type { AwsClient } from 'aws4fetch';

/**
 * PUTs bytes to R2, signed by `client`, with an explicit Content-Length. R2 refuses a PUT without one (HTTP
 * 411), and inside Next.js's server the global `fetch` can send the body chunked, without a length. So
 * this signs with aws4fetch and sends with Node's own `https`.
 */
export async function r2Put(
  client: AwsClient,
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): Promise<void> {
  const body = new Uint8Array(bytes);
  const signed = await client.sign(url, {
    method: 'PUT',
    body,
    headers: { ...headers, 'Content-Length': String(body.byteLength) },
  });
  const sent: Record<string, string> = {};
  signed.headers.forEach((value, name) => (sent[name] = value));
  sent['content-length'] = String(body.byteLength);

  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(signed.url, { method: 'PUT', headers: sent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
  if (status < 200 || status >= 300) throw new Error(`R2 upload: HTTP ${status}: ${text.slice(0, 200)}`);
}
