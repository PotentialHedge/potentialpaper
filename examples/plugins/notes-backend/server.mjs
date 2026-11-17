// The backend of the "Private notes" example plugin (`examples/plugins/notes`): a plugin's own server, which the site
// never runs. Node 18+, no dependencies:
//
//   SITE=http://localhost:3000 DEV=1 node examples/plugins/notes-backend/server.mjs
//
// Each request carries `Authorization: Bearer <identity token>` (`pp.identity.fetch`). The token is checked against the
// site's published keys, for this plugin's id, and the notes are kept under its `sub`. Nothing here sees the reader's
// session; a token from another plugin is refused.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { identityVerifier } from './verify.mjs';

const SITE = process.env.SITE || 'http://localhost:3000';
const PLUGIN = process.env.PLUGIN || 'potentialhedge/notes';
const PORT = Number(process.env.PORT || 8787);
const DATA = process.env.DATA_FILE || 'notes.json';
// A plugin loaded from localhost gets tokens for `dev:<id>` (anyone can claim any id on their own machine). Accept them
// only while developing.
const DEV = process.env.DEV === '1';

const verifier = identityVerifier({ site: SITE, plugin: PLUGIN, dev: DEV });
let notes = {};
try {
  notes = JSON.parse(readFileSync(DATA, 'utf8'));
} catch {
  notes = {};
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // Bearer tokens, not cookies: any origin may call, and only a good token gets anything.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64 * 1024) throw new Error('too long');
  }
  return JSON.parse(text || '{}');
}

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/notes') return send(res, 404, { error: 'not found' });
  const page = url.searchParams.get('page');
  if (!page || page.length > 400) return send(res, 400, { error: 'name a page' });
  let claims;
  try {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return send(res, 401, { error: 'no token' });
    claims = await verifier.verify(token);
  } catch (e) {
    return send(res, 401, { error: e.message });
  }
  const mine = (notes[claims.sub] ??= {});
  if (req.method === 'GET') return send(res, 200, mine[page] ?? { text: '', updatedAt: null });
  if (req.method === 'PUT') {
    try {
      const { text } = await readBody(req);
      if (typeof text !== 'string') return send(res, 400, { error: 'text is a string' });
      mine[page] = { text, updatedAt: new Date().toISOString() };
      writeFileSync(DATA, JSON.stringify(notes));
      return send(res, 200, mine[page]);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  send(res, 405, { error: 'GET or PUT' });
}).listen(PORT, () => {
  console.log(`notes backend for ${verifier.audience} from ${verifier.issuer} on http://localhost:${PORT}`);
});
