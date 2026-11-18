import { z } from 'zod';
import { requireVerified } from '../auth';
import { mustFindPage, mustFindScope } from '../plugins/pages';
import {
  listSignalSets,
  MAX_VALUES_PER_WRITE,
  mustFindSet,
  nearestPapers,
  paperSignals,
  publishGeneration,
  registerSignalSet,
  signalColumns,
  signalEtagOf,
  signalSetView,
  stageGeneration,
  writeSignalLabels,
  writeSignalValues,
} from '../signals';
import { ApiError } from './errors';
import { etagOf, notModified, parseBody, parseQuery, route } from './http';

/**
 * The signals API (`handoffs/signals.md`). Reads are public and cached; writes are the set's publisher's, with a
 * session or an API key that may write. Every response names the set its values came from.
 */

const PUBLIC_MINUTE = { 'Cache-Control': 'public, max-age=60' };

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return Response.json(body, { status: init.status ?? 200, headers: { 'Cache-Control': 'no-store', ...init.headers } });
}

function setIdOf(params: Record<string, string | string[]>): string {
  const owner = String(params.owner ?? '');
  const name = String(params.name ?? '');
  return `${owner}/${name}`.toLowerCase();
}

/** `GET /signal-sets`: every set. `POST /signal-sets` `{ source }`: register a set, or take its manifest again. */
export const listSets = route(async () => json({ sets: await listSignalSets() }, { headers: PUBLIC_MINUTE }));

const RegisterBody = z.object({ source: z.string().min(1).max(300) });
export const registerSet = route(async (req) => {
  const principal = await requireVerified(req);
  const { source } = await parseBody(req, RegisterBody);
  return json(await registerSignalSet(principal.account, source), { status: 201 });
});

/** `GET /signal-sets/{owner}/{name}`: a set, its signals and how many papers each covers. */
export const getSet = route(async (_req, params) =>
  json(await signalSetView(setIdOf(params)), { headers: PUBLIC_MINUTE }),
);

const ColumnsQuery = z.object({
  signals: z
    .string()
    .max(500)
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : [])),
  scope: z.string().max(400).optional(),
  titles: z
    .enum(['true', 'false'])
    .optional()
    .transform((s) => s === 'true'),
});

/**
 * `GET /signal-sets/{owner}/{name}/columns?signals=map.xy,map.region&scope=venue:iclr/2027&titles=true`: those
 * signals for every paper here that has one, by column (`SignalColumns`). Public, with an ETag that changes only when
 * the set does.
 */
export const getColumns = route(async (req, params) => {
  const setId = setIdOf(params);
  const query = parseQuery(req, ColumnsQuery);
  const set = await mustFindSet(setId);
  const scope = query.scope ? await mustFindScope(query.scope) : null;
  const etag = etagOf(signalEtagOf(set, query.signals, scope?.id ?? null, query.titles));
  const headers = { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600', ETag: etag };
  if (notModified(req, etag)) return new Response(null, { status: 304, headers });
  const columns = await signalColumns(setId, query.signals, { scopeId: scope?.id, titles: query.titles });
  return json(columns, { headers });
});

const NearestQuery = z.object({
  signal: z.string().min(1).max(200),
  paper: z.string().min(1).max(400),
  k: z.coerce.number().int().min(1).max(200).default(20),
});

/** `GET /signal-sets/{owner}/{name}/nearest?signal=embedding&paper=openreview:abc&k=20`: the nearest papers. */
export const getNearest = route(async (req, params) => {
  const setId = setIdOf(params);
  const query = parseQuery(req, NearestQuery);
  const page = await mustFindPage(query.paper);
  if (page.kind !== 'paper') throw new ApiError(422, 'validation_error', `${query.paper} is not a paper`);
  const set = await mustFindSet(setId);
  const etag = etagOf(signalEtagOf(set, 'nearest', query.signal, page.id, query.k));
  const headers = { 'Cache-Control': 'public, max-age=300', ETag: etag };
  if (notModified(req, etag)) return new Response(null, { status: 304, headers });
  const found = await nearestPapers(setId, query.signal, page.id, query.k);
  return json({ set: setId, signal: query.signal, ...found }, { headers });
});

/** `GET /pages/{identifier}/signals[?set=owner/name]`: one paper's values, by set. */
const PaperSignalsQuery = z.object({ set: z.string().max(120).optional() });
export const getPaperSignals = route(async (req, params) => {
  const raw = params.identifier;
  const identifier = decodeURIComponent(Array.isArray(raw) ? raw.join('/') : (raw ?? ''));
  const page = await mustFindPage(identifier);
  if (page.kind !== 'paper') throw new ApiError(422, 'validation_error', `${identifier} is not a paper`);
  const { set } = parseQuery(req, PaperSignalsQuery);
  return json({ sets: await paperSignals(page.id, set?.toLowerCase()) }, { headers: PUBLIC_MINUTE });
});

/** `POST /signal-sets/{owner}/{name}/generations`: start a new generation to write a rebuild into. */
export const postGeneration = route(async (req, params) => {
  const principal = await requireVerified(req);
  return json(await stageGeneration(principal.account, setIdOf(params)), { status: 201 });
});

/** `POST /signal-sets/{owner}/{name}/generations/{generation}/publish`: make it live, at once. */
export const postPublish = route(async (req, params) => {
  const principal = await requireVerified(req);
  const generation = Number(params.generation);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new ApiError(400, 'validation_error', 'a generation is a positive whole number');
  }
  return json(await publishGeneration(principal.account, setIdOf(params), generation));
});

const GenerationQuery = z.object({ generation: z.coerce.number().int().min(1).optional() });
const ValuesBody = z.object({
  values: z
    .array(
      z.object({
        paper: z.string().min(1).max(400),
        signal: z.string().min(1).max(200),
        value: z.union([z.array(z.number()).max(2048), z.number(), z.string().max(100), z.null()]),
      }),
    )
    .max(MAX_VALUES_PER_WRITE),
});

/** `PUT /signal-sets/{owner}/{name}/values[?generation=n]` `{ values: [{ paper, signal, value }] }`. */
export const putValues = route(async (req, params) => {
  const principal = await requireVerified(req);
  const { generation } = parseQuery(req, GenerationQuery);
  const { values } = await parseBody(req, ValuesBody);
  return json(await writeSignalValues(principal.account, setIdOf(params), values, { generation }));
});

const LabelsBody = z.object({
  signal: z.string().min(1).max(200),
  labels: z.array(z.object({ key: z.string().min(1).max(100), title: z.string().min(1).max(200) })),
});

/** `PUT /signal-sets/{owner}/{name}/labels[?generation=n]` `{ signal, labels: [{ key, title }] }`. */
export const putLabels = route(async (req, params) => {
  const principal = await requireVerified(req);
  const { generation } = parseQuery(req, GenerationQuery);
  const { signal, labels } = await parseBody(req, LabelsBody);
  return json(await writeSignalLabels(principal.account, setIdOf(params), signal, labels, { generation }));
});
