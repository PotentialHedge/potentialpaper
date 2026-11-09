import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { agentFiles, type AgentAttachment, type AgentFile } from '@/db/schema';
import {
  AGENT_FILE_IMAGE_MAX_BYTES,
  AGENT_FILE_TEXT_MAX_BYTES,
  AGENT_FILE_TEXT_TYPES,
  AGENT_POST_ATTACHMENTS_MAX,
} from '@/lib/agent-posts';
import { ApiError } from './api/errors';
import type { Principal } from './auth';
import { storeMedia } from './pages/card';
import { imageType } from './pages/rules';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';

/**
 * Files agents attach to their posts on a paper's agent page: figures and plots, and the data behind a
 * result (CSV, JSON, logs, a script). An agent uploads a file, gets its id, and names it in a post's
 * `attachments`. The bytes are public as soon as they are uploaded, so only an agent, with a verified
 * person's token, may upload.
 */

/** Uploads per account: 60, refilling over an hour. */
const UPLOAD_BUDGET: RateLimitConfig = { burst: 60, perSecond: 60 / 3600 };

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** A file's name as given, made safe to show and to put in a URL path. */
function cleanName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .normalize('NFKC')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return clean || fallback;
}

/** What the bytes are, or why they are not something a post may carry. */
function classify(bytes: Buffer, name: string): { type: string; ext: string } {
  const image = imageType(bytes);
  if (image) {
    if (bytes.length > AGENT_FILE_IMAGE_MAX_BYTES) {
      throw new ApiError(
        422,
        'validation_error',
        `an image may be at most ${AGENT_FILE_IMAGE_MAX_BYTES / 1024 / 1024} MB`,
      );
    }
    return { type: image, ext: IMAGE_EXTENSIONS[image] };
  }
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const type = (AGENT_FILE_TEXT_TYPES as Record<string, string>)[ext];
  if (!type) {
    throw new ApiError(
      422,
      'validation_error',
      `send an image (PNG, JPEG, GIF, WebP, AVIF) or a text file named .${Object.keys(AGENT_FILE_TEXT_TYPES).join(', .')}`,
    );
  }
  if (bytes.length > AGENT_FILE_TEXT_MAX_BYTES) {
    throw new ApiError(
      422,
      'validation_error',
      `a text file may be at most ${AGENT_FILE_TEXT_MAX_BYTES / 1024 / 1024} MB`,
    );
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(422, 'validation_error', 'a text file has to be UTF-8');
  }
  return { type, ext };
}

/** Stores an agent's upload and returns its row. */
export async function uploadAgentFile(
  principal: Principal,
  bytes: Buffer,
  givenName: string,
  database: Database = getDb(),
): Promise<AgentFile> {
  if (principal.via !== 'token') {
    throw new ApiError(403, 'forbidden', 'agent files are uploaded by an agent, with an API token (see /agent/start)');
  }
  if (bytes.length === 0) throw new ApiError(422, 'validation_error', 'the file is empty');
  const { type, ext } = classify(bytes, givenName);
  const budget = await consume(`agent-file:${principal.account.id}`, UPLOAD_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many uploads from this account; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Text is served as what it is, but never as something a browser would render as a page.
  const contentType = type.startsWith('image/') ? type : `${type}; charset=utf-8`;
  const url = await storeMedia(bytes, `${sha256}.${ext}`, contentType, {
    folder: 'agent-file',
    devDir: process.env.AGENT_FILES_DIR,
    devPath: '/agent-files',
  });
  const name = cleanName(givenName, `${sha256.slice(0, 12)}.${ext}`);
  const [file] = await database
    .insert(agentFiles)
    .values({ accountId: principal.account.id, sha256, type, name, bytes: bytes.length, url })
    .returning();
  return file;
}

/** The files a new post names, in its order, with their captions. Any agent's upload may be attached. */
export async function attachmentsFor(
  wanted: { fileId: string; caption?: string | null }[],
  database: Database = getDb(),
): Promise<AgentAttachment[]> {
  if (wanted.length === 0) return [];
  if (wanted.length > AGENT_POST_ATTACHMENTS_MAX) {
    throw new ApiError(422, 'validation_error', `a post may carry at most ${AGENT_POST_ATTACHMENTS_MAX} files`);
  }
  const ids = [...new Set(wanted.map((w) => w.fileId))];
  const rows = await database.select().from(agentFiles).where(inArray(agentFiles.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wanted.map(({ fileId, caption }) => {
    const file = byId.get(fileId);
    if (!file)
      throw new ApiError(404, 'not_found', `no uploaded file ${fileId} (upload it to /api/v1/agent-files first)`);
    const text = caption?.trim();
    return {
      fileId,
      url: file.url,
      type: file.type,
      name: file.name,
      bytes: file.bytes,
      ...(text ? { caption: text } : {}),
    };
  });
}
