import { z } from 'zod';
import * as S from './schemas';

/**
 * `/openapi.json`: an OpenAPI 3.1 description of the public page routes (`GET /api/v1/pages/{identifier}/…`, and the
 * topic and change lists, `/topics` and `/changes`), which
 * plugins (through the SDK) and outside backends (`handoffs/plugins.md`, data for plugins A, B and D) read alike. The
 * response bodies are made from the same zod schemas the routes check their answers against, so the two can't drift.
 * Also `/.well-known/jwks.json`, for plugins' backends (data for plugins D). The rest of the API is described in `/llms.txt` and the agent instructions; it can join here route by route.
 */

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' });

const identifier = {
  name: 'identifier',
  in: 'path',
  required: true,
  description:
    "A page's identifier, URL-encoded as one path segment: `venue%3Aiclr%2F2027`, `topic%3Alinear-attention`, `arxiv%3A1706.03762`.",
  schema: { type: 'string' },
};

const query = (name: string, description: string, schema: Record<string, unknown>) => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
});

const ERROR = {
  description: 'An error: `{ "error": { "code", "message", "details"? } }`.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
            required: ['code', 'message'],
          },
        },
        required: ['error'],
      },
    },
  },
};

const CACHED = 'Public; `Cache-Control: public, max-age=60`.';
const ETAGGED = `${CACHED} Sends an \`ETag\`; a request with a matching \`If-None-Match\` gets a 304 and no body.`;

function get(summary: string, description: string, body: z.ZodType, parameters: object[] = [identifier]) {
  return {
    get: {
      summary,
      description,
      parameters,
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: json(body) } } },
        '404': ERROR,
        '422': ERROR,
      },
    },
  };
}

const BULK_ROW = {
  type: 'object',
  description: 'One paper of the scope.',
  properties: {
    identifier: { type: ['string', 'null'], description: "The paper's identifier (`arxiv:…`); null without one." },
    address: { type: ['string', 'null'], description: 'Its path on the site.' },
    title: { type: 'string' },
    year: { type: ['integer', 'null'] },
    submissions: {
      type: 'array',
      description: 'Every submission of the paper (with any of `fields`).',
      items: {
        type: 'object',
        properties: {
          venue: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' } },
            required: ['id', 'name'],
          },
          externalId: { type: 'string' },
          number: { type: ['integer', 'null'] },
          url: { type: ['string', 'null'] },
          status: {
            type: ['string', 'null'],
            enum: ['under_review', 'accepted', 'rejected', 'withdrawn', 'desk_rejected', null],
            description: 'With `status`.',
          },
          decision: { type: ['string', 'null'], description: 'With `status`: as the venue words it.' },
          reviews: {
            type: 'array',
            description: "With `scores`: each review's score fields. CC BY 4.0: keep `license` and `url` with them.",
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                signature: { type: 'string' },
                scores: { type: 'object', additionalProperties: { type: 'number' } },
                url: { type: ['string', 'null'] },
                license: { type: 'string' },
              },
              required: ['id', 'signature', 'scores', 'url', 'license'],
            },
          },
        },
        required: ['venue', 'externalId', 'number', 'url'],
      },
    },
  },
  required: ['identifier', 'address', 'title', 'year'],
};

export function openApiDocument(origin: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'PotentialPaper pages',
      version: '1',
      description:
        "The public reads of any page by its identifier: what plugins read through the SDK and backends read over HTTP. No token is needed. Reviews are OpenReview's, CC BY 4.0: each carries its licence and source link.",
    },
    servers: [{ url: `${origin}/api/v1` }],
    paths: {
      '/pages/{identifier}': get(
        "A page's summary",
        `Its kind, identifier, address and name, the pages above it, and what \`when\` conditions test. ${CACHED}`,
        S.PageResponse,
      ),
      '/pages/{identifier}/files': get(
        "A page's files",
        `Its kind file, sections and links, as the public sees them. ${CACHED}`,
        S.PageFiles,
      ),
      '/pages/{identifier}/members': get(
        "A scope's papers",
        `A venue's, topic's or organisation's papers, paged, rolled up from the pages under it. ${CACHED}`,
        S.PageMembers,
        [
          identifier,
          query('offset', 'Where to start.', { type: 'integer', minimum: 0, default: 0 }),
          query('limit', 'How many.', { type: 'integer', minimum: 1, maximum: 200, default: 100 }),
          query('rollUp', 'Include the pages under it.', { type: 'string', enum: ['true', 'false'], default: 'true' }),
        ],
      ),
      '/pages/{identifier}/submissions': get(
        "A paper's submissions",
        `Its submissions with their notes (reviews, decisions, comments) and the venues' forms. ${CACHED}`,
        S.PageSubmissions,
      ),
      '/pages/{identifier}/venue-papers': get(
        "A venue's submissions by status",
        `Rolled up from its editions, accepted first. ${CACHED}`,
        S.VenuePapers,
        [
          identifier,
          query('status', 'Only this status.', {
            type: 'string',
            enum: ['accepted', 'under_review', 'rejected', 'desk_rejected', 'withdrawn', 'unknown'],
          }),
          query('decision', 'Only this decision, as the venue words it.', { type: 'string' }),
          query('q', 'Words in the title.', { type: 'string' }),
          query('offset', 'Where to start.', { type: 'integer', minimum: 0, default: 0 }),
          query('limit', 'How many.', { type: 'integer', minimum: 1, maximum: 200, default: 50 }),
        ],
      ),
      '/pages/{identifier}/org': get(
        "An organisation's overview",
        `The organisation above it, its departments and labs with their papers, the members who show it as their institution (by handle), and the venues and topics its papers are at, by count. ${CACHED}`,
        S.OrgOverview,
      ),
      '/pages/{identifier}/topic': get(
        "A topic's overview",
        `Its other names; its broader, narrower and related topics with their papers; the papers that introduced it; the venues and organisations its papers are at, by count; the first papers that might belong in it; the topics merged into it; and its protection. ${CACHED}`,
        S.TopicOverview,
      ),
      '/pages/{identifier}/topic-papers': get(
        "A topic's papers",
        `Rolled up from its narrower topics, each with the narrower topic it is in, whether it introduced the topic, and its submission (accepted first, else the latest) with the mean of its venue's first score field over its reviews. By score, papers are ordered by where that mean sits in the venue's range. ${CACHED}`,
        S.TopicPapers,
        [
          identifier,
          query('sort', 'The order.', { type: 'string', enum: ['date', 'venue', 'score'], default: 'date' }),
          query('offset', 'Where to start.', { type: 'integer', minimum: 0, default: 0 }),
          query('limit', 'How many.', { type: 'integer', minimum: 1, maximum: 200, default: 50 }),
        ],
      ),
      '/pages/{identifier}/suggestions': get(
        'Papers that might belong in a topic',
        `Found by the topic's names in OpenReview keywords, titles and abstracts, best first; none a person dismissed. ${CACHED}`,
        S.Suggestions,
        [
          identifier,
          query('offset', 'Where to start.', { type: 'integer', minimum: 0, default: 0 }),
          query('limit', 'How many.', { type: 'integer', minimum: 1, maximum: 200, default: 50 }),
        ],
      ),
      '/pages/{identifier}/protection': get(
        "A page's protection",
        `Whether only established accounts (\`established\`) or only admins (\`admins\`) may edit what the community writes on it; \`null\` when it isn't protected. ${CACHED}`,
        S.Protection,
      ),
      '/topics': get(
        'Topics by name',
        `Topics whose name or an alias is like \`q\`, the same name (\`exact\`) first. ${CACHED}`,
        S.TopicMatches,
        [query('q', 'A name.', { type: 'string' })],
      ),
      '/changes': get(
        'Recent changes',
        `Every commit to every page, newest first (the patrol feed). \`rollUp\` keeps the changes that move papers between topics: a topic's broader topics, merges and renames. ${CACHED}`,
        S.Changes,
        [
          query('kind', 'Only pages of this kind.', {
            type: 'string',
            enum: ['paper', 'venue', 'topic', 'org', 'user'],
          }),
          query('rollUp', 'Only changes that move papers between topics.', {
            type: 'string',
            enum: ['true', 'false'],
            default: 'false',
          }),
          query('bots', "Bots' commits too.", { type: 'string', enum: ['true', 'false'], default: 'false' }),
          query('before', 'Older than this change (`next` of the previous page).', { type: 'integer' }),
          query('limit', 'How many.', { type: 'integer', minimum: 1, maximum: 200, default: 50 }),
        ],
      ),
      '/pages/{identifier}/scores': get(
        "A scope's score statistics",
        `The venues its papers were submitted to and each score field of their review forms, with counts, venues with the most submissions first. Each venue names its own page (\`venue.page\`), whose statistics are the whole venue's. A site may withhold a venue's numbers until its decisions are out (\`hidden\`). ${ETAGGED}`,
        S.PageScores,
      ),
      '/pages/{identifier}/scores/{venue}/{field}': get(
        'One score field at one venue',
        `Every submission's mean over its reviews, ascending; fixed-width bins between the form's range; and the same split by outcome (accepted, rejected, withdrawn, pending). Recomputed a few seconds after a change. ${ETAGGED}`,
        S.PageScoreField,
        [
          identifier,
          {
            name: 'venue',
            in: 'path',
            required: true,
            description: "The venue's id, URL-encoded: `openreview%3AICLR.cc%2F2027%2FConference`.",
            schema: { type: 'string' },
          },
          {
            name: 'field',
            in: 'path',
            required: true,
            description: "The field's key in the venue's forms: `rating`.",
            schema: { type: 'string' },
          },
          query(
            'marks',
            "`true` adds `marks`: the scope's own submissions in this field, each with its paper and mean, ascending (`null` above 1,000). For a topic or an org, draw the whole venue from `venue.page`'s statistics and mark these on it.",
            { type: 'string', enum: ['true', 'false'], default: 'false' },
          ),
        ],
      ),
      '/pages/{identifier}/papers': {
        get: {
          summary: "A scope's papers in bulk",
          description: `NDJSON, one paper a line, in a stable order: each with every submission, its status and decision, and each review's score vector. Without \`limit\`, every paper in one stream; with it, one chunk and the next chunk's cursor in \`X-Next-Cursor\`. Compressed (zstd, br or gzip) when the request accepts it. The \`ETag\` changes with the scope's last change. ${CACHED}`,
          parameters: [
            identifier,
            query(
              'fields',
              'Comma-separated: `submissions`, `scores`, `status`. All three by default; empty for the papers alone.',
              {
                type: 'string',
              },
            ),
            query('limit', 'Papers in this chunk.', { type: 'integer', minimum: 1, maximum: 5000 }),
            query('after', 'The cursor a previous chunk gave in `X-Next-Cursor`.', { type: 'string', format: 'uuid' }),
          ],
          responses: {
            '200': {
              description: 'One JSON object a line.',
              headers: {
                ETag: { schema: { type: 'string' } },
                'X-Next-Cursor': {
                  description: 'With `limit`: the cursor of the next chunk; absent at the end.',
                  schema: { type: 'string' },
                },
              },
              content: { 'application/x-ndjson': { schema: BULK_ROW } },
            },
            '304': { description: 'Not modified.' },
            '400': ERROR,
            '404': ERROR,
            '422': ERROR,
          },
        },
      },
      '/.well-known/jwks.json': {
        servers: [{ url: origin }],
        get: {
          summary: "The keys that sign plugins' identity tokens",
          description:
            "For a plugin's own backend: the public ES256 keys (a JWKS) that sign the tokens `pp.identity.token()` gives a plugin with the `identity` permission. Verify a token with the key its header's `kid` names, `iss` the site's origin and `aud` your plugin's id, and key what you keep by `sub` (the reader, pairwise per plugin). Fetch again when a token names a `kid` you don't have: keys rotate, and every live key is listed. Public; `Cache-Control: public, max-age=300`.",
          responses: {
            '200': { description: 'OK', content: { 'application/json': { schema: json(S.Jwks) } } },
          },
        },
      },
    },
  };
}
