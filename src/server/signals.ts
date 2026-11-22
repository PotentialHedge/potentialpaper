import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, signalLabels, signalSets, signals, signalValues, type Account } from '@/db/schema';
import { formatIdentifier, parseIdentifier } from '@/lib/kinds';
import type { SignalSpec } from '@/lib/plugins/manifest';
import { parsePluginSource } from '@/lib/plugins/sources';
import { PLUGIN_ID_RE } from '@/lib/settings/spec';
import { ApiError } from './api/errors';
import { snapshotPlugin } from './plugins/snapshot';
import { scopePagesOf } from './scope-stats';

/**
 * Signals (`handoffs/signals.md`): values an app computes about papers, in sets. A set is a plugin's
 * `contributes.signals`; the account its manifest names as `publisher` registers it here and alone writes its values,
 * so a bad set harms only the readers who chose it, and every read names the set it came from.
 *
 * Values are written per **generation**. Small updates go to the live one. A rebuild (a new map layout) stages a new
 * generation, writes all of it, and publishes it, which swaps it in at once and drops the old one. Values are keyed by
 * the paper identifier the publisher gave and matched to papers when read, so they may arrive before the paper does,
 * and a merged paper's values follow it to the survivor.
 */

/** Rows one write may carry. */
export const MAX_VALUES_PER_WRITE = 5000;
/** Labels one signal may name in a generation. */
export const MAX_LABELS = 20_000;

export interface SetSignal {
  name: string;
  kind: SignalSpec['kind'];
  spec: SignalSpec;
}

export interface SignalSetView {
  id: string;
  name: string;
  description: string | null;
  source: string;
  commit: string;
  publisher: string;
  generation: number;
  staged: number | null;
  changedAt: Date;
  signals: (SetSignal & { count: number })[];
}

type SetRow = typeof signalSets.$inferSelect;
/** The database, or a transaction on it. */
type Db = Pick<Database, 'select' | 'execute' | 'insert' | 'update' | 'delete'>;

async function findSet(id: string, database: Db): Promise<SetRow | null> {
  const [row] = await database.select().from(signalSets).where(eq(signalSets.id, id));
  return row ?? null;
}

export async function mustFindSet(id: string, database: Db = getDb()): Promise<SetRow> {
  if (!PLUGIN_ID_RE.test(id)) throw new ApiError(400, 'validation_error', `"${id}" is not a set id ("<owner>/<name>")`);
  const set = await findSet(id, database);
  if (!set) throw new ApiError(404, 'not_found', `no signal set ${id}`);
  return set;
}

async function setSignals(setId: string, database: Db): Promise<SetSignal[]> {
  const rows = await database.select().from(signals).where(eq(signals.setId, setId)).orderBy(signals.name);
  return rows.map((row) => ({ name: row.name, kind: row.kind, spec: row.spec as unknown as SignalSpec }));
}

/** A set as everyone may see it: its signals, and how many values each has in the live generation. */
export async function signalSetView(id: string, database: Database = getDb()): Promise<SignalSetView> {
  const set = await mustFindSet(id, database);
  const [list, counts, [publisher]] = await Promise.all([
    setSignals(id, database),
    database
      .select({ signal: signalValues.signal, count: sql<number>`count(*)::int` })
      .from(signalValues)
      .where(and(eq(signalValues.setId, id), eq(signalValues.generation, set.liveGeneration)))
      .groupBy(signalValues.signal),
    database.select({ handle: accounts.handle }).from(accounts).where(eq(accounts.id, set.publisherId)),
  ]);
  const count = new Map(counts.map((c) => [c.signal, c.count]));
  return {
    id: set.id,
    name: set.name,
    description: set.description,
    source: set.source,
    commit: set.commit,
    publisher: publisher?.handle ?? '',
    generation: set.liveGeneration,
    staged: set.stagedGeneration,
    changedAt: set.changedAt,
    signals: list.map((s) => ({ ...s, count: count.get(s.name) ?? 0 })),
  };
}

/** Every registered set, newest first. */
export async function listSignalSets(database: Database = getDb()) {
  const rows = await database
    .select({ id: signalSets.id, name: signalSets.name, description: signalSets.description, handle: accounts.handle })
    .from(signalSets)
    .innerJoin(accounts, eq(accounts.id, signalSets.publisherId))
    .orderBy(sql`${signalSets.createdAt} desc`);
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, publisher: r.handle }));
}

/**
 * Register a set from its GitHub source, or take its manifest again (a new signal, a changed title). The manifest
 * must declare signals and name the caller as its `publisher`. A signal the new manifest drops loses its values.
 */
export async function registerSignalSet(account: Account, sourceText: string, database: Database = getDb()) {
  const source = parsePluginSource(sourceText);
  if (!source || source.kind !== 'github') {
    throw new ApiError(400, 'validation_error', 'a set\'s source is "github:<owner>/<repo>[/<folder>][@<ref>]"');
  }
  const snapshot = await snapshotPlugin(source, { update: true, database });
  const manifest = snapshot.manifest;
  const declared = manifest.contributes.signals ?? [];
  if (declared.length === 0) {
    throw new ApiError(422, 'validation_error', `${manifest.id} declares no signals (contributes.signals)`);
  }
  if (manifest.publisher?.toLowerCase() !== account.handle?.toLowerCase()) {
    throw new ApiError(
      403,
      'forbidden',
      `${manifest.id}'s manifest names ${manifest.publisher ? `@${manifest.publisher}` : 'no one'} as its publisher, not @${account.handle}`,
    );
  }
  await database.transaction(async (tx) => {
    const existing = await findSet(manifest.id, tx);
    const values = {
      source: snapshot.source,
      commit: snapshot.commit,
      publisherId: account.id,
      name: manifest.name,
      description: manifest.description ?? null,
    };
    if (existing) {
      await tx
        .update(signalSets)
        .set({ ...values, changedAt: sql`clock_timestamp()` })
        .where(eq(signalSets.id, manifest.id));
    } else {
      await tx.insert(signalSets).values({ id: manifest.id, ...values });
    }
    const names = declared.map((s) => s.id);
    const before = await setSignals(manifest.id, tx);
    const dropped = before
      .filter((s) => !names.includes(s.name) || s.kind !== declared.find((d) => d.id === s.name)?.kind)
      .map((s) => s.name);
    if (dropped.length) {
      await tx
        .delete(signalValues)
        .where(and(eq(signalValues.setId, manifest.id), inArray(signalValues.signal, dropped)));
      await tx
        .delete(signalLabels)
        .where(and(eq(signalLabels.setId, manifest.id), inArray(signalLabels.signal, dropped)));
    }
    await tx.delete(signals).where(eq(signals.setId, manifest.id));
    await tx.insert(signals).values(
      declared.map((spec) => ({
        setId: manifest.id,
        name: spec.id,
        kind: spec.kind,
        spec: spec as unknown as Record<string, unknown>,
      })),
    );
  });
  return signalSetView(manifest.id, database);
}

async function mustPublish(account: Account, setId: string, database: Db): Promise<SetRow> {
  const set = await mustFindSet(setId, database);
  if (set.publisherId !== account.id) {
    throw new ApiError(403, 'forbidden', `only ${setId}'s publisher writes its signals`);
  }
  return set;
}

/** The generation a write goes to: the live one unless told, else the staged one. */
function writableGeneration(set: SetRow, generation: number | undefined): number {
  if (generation === undefined || generation === set.liveGeneration) return set.liveGeneration;
  if (generation === set.stagedGeneration) return generation;
  throw new ApiError(
    409,
    'generation_conflict',
    `generation ${generation} is neither live (${set.liveGeneration}) nor staged (${set.stagedGeneration ?? 'none'})`,
  );
}

/** Start a new generation beside the live one, dropping any earlier staged one that was never published. */
export async function stageGeneration(account: Account, setId: string, database: Database = getDb()) {
  return database.transaction(async (tx) => {
    const set = await mustPublish(account, setId, tx);
    if (set.stagedGeneration !== null) await dropGeneration(tx, setId, set.stagedGeneration);
    const generation = Math.max(set.liveGeneration, set.stagedGeneration ?? 0) + 1;
    await tx.update(signalSets).set({ stagedGeneration: generation }).where(eq(signalSets.id, setId));
    return { generation, live: set.liveGeneration };
  });
}

async function dropGeneration(database: Db, setId: string, generation: number) {
  await database
    .delete(signalValues)
    .where(and(eq(signalValues.setId, setId), eq(signalValues.generation, generation)));
  await database
    .delete(signalLabels)
    .where(and(eq(signalLabels.setId, setId), eq(signalLabels.generation, generation)));
}

/** Make the staged generation the live one, at once, and drop the one it replaces. */
export async function publishGeneration(
  account: Account,
  setId: string,
  generation: number,
  database: Database = getDb(),
) {
  return database.transaction(async (tx) => {
    const set = await mustPublish(account, setId, tx);
    if (set.stagedGeneration !== generation) {
      throw new ApiError(409, 'generation_conflict', `generation ${generation} is not the staged one`);
    }
    await tx
      .update(signalSets)
      .set({ liveGeneration: generation, stagedGeneration: null, changedAt: sql`clock_timestamp()` })
      .where(eq(signalSets.id, setId));
    await dropGeneration(tx, setId, set.liveGeneration);
    return { generation };
  });
}

export interface SignalValueInput {
  /** The paper's identifier: `openreview:abc`, `arxiv:2401.01234`, `doi:…`. */
  paper: string;
  signal: string;
  /** A vector's numbers, a number, or a label's key; `null` removes the value. */
  value: number[] | number | string | null;
}

function paperKey(text: string): { scheme: string; value: string } | null {
  const address = parseIdentifier(text);
  return address?.kind === 'paper' ? address.id : null;
}

/** Write values, each checked against its signal; every problem is reported at once, with its row's index. */
export async function writeSignalValues(
  account: Account,
  setId: string,
  rows: SignalValueInput[],
  options: { generation?: number; database?: Database } = {},
) {
  const database = options.database ?? getDb();
  if (rows.length > MAX_VALUES_PER_WRITE) {
    throw new ApiError(400, 'validation_error', `at most ${MAX_VALUES_PER_WRITE} values a write`);
  }
  const set = await mustPublish(account, setId, database);
  const generation = writableGeneration(set, options.generation);
  const specs = new Map((await setSignals(setId, database)).map((s) => [s.name, s.spec]));
  const problems: string[] = [];
  const upserts: (typeof signalValues.$inferInsert)[] = [];
  const removals: { signal: string; scheme: string; value: string }[] = [];
  rows.forEach((row, i) => {
    const at = `values[${i}]`;
    const spec = specs.get(row.signal);
    if (!spec) return problems.push(`${at}.signal: ${setId} has no signal "${row.signal}"`);
    const key = paperKey(row.paper);
    if (!key) return problems.push(`${at}.paper: "${row.paper}" is not a paper identifier`);
    if (row.value === null) return removals.push({ signal: row.signal, ...key });
    const base = { setId, generation, signal: row.signal, ...key };
    if (spec.kind === 'vector') {
      const v = row.value;
      if (!Array.isArray(v) || v.length !== spec.dims || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        return problems.push(`${at}.value: ${row.signal} is a vector of ${spec.dims} finite numbers`);
      }
      upserts.push({ ...base, vec: v });
    } else if (spec.kind === 'number') {
      const v = row.value;
      if (typeof v !== 'number' || !Number.isFinite(v)) return problems.push(`${at}.value: ${row.signal} is a number`);
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
        return problems.push(`${at}.value: ${row.signal} is between ${spec.min ?? '-∞'} and ${spec.max ?? '∞'}`);
      }
      upserts.push({ ...base, num: v });
    } else {
      const v = row.value;
      if (typeof v !== 'string' || v.length === 0 || v.length > 100) {
        return problems.push(`${at}.value: ${row.signal} is a label's key, 1 to 100 characters`);
      }
      upserts.push({ ...base, label: v });
    }
  });
  if (problems.length) throw new ApiError(400, 'validation_error', problems.slice(0, 50).join('\n'));
  await database.transaction(async (tx) => {
    for (let i = 0; i < upserts.length; i += 1000) {
      await tx
        .insert(signalValues)
        .values(upserts.slice(i, i + 1000))
        .onConflictDoUpdate({
          target: [
            signalValues.setId,
            signalValues.generation,
            signalValues.signal,
            signalValues.scheme,
            signalValues.value,
          ],
          set: {
            num: sql`excluded.num`,
            label: sql`excluded.label`,
            vec: sql`excluded.vec`,
            updatedAt: sql`clock_timestamp()`,
          },
        });
    }
    for (const r of removals) {
      await tx
        .delete(signalValues)
        .where(
          and(
            eq(signalValues.setId, setId),
            eq(signalValues.generation, generation),
            eq(signalValues.signal, r.signal),
            eq(signalValues.scheme, r.scheme),
            eq(signalValues.value, r.value),
          ),
        );
    }
    if (generation === set.liveGeneration) {
      await tx
        .update(signalSets)
        .set({ changedAt: sql`clock_timestamp()` })
        .where(eq(signalSets.id, setId));
    }
  });
  return { generation, written: upserts.length, removed: removals.length };
}

/** Name a label signal's values in a generation (its regions, its clusters), replacing the names it had there. */
export async function writeSignalLabels(
  account: Account,
  setId: string,
  signal: string,
  labels: { key: string; title: string }[],
  options: { generation?: number; database?: Database } = {},
) {
  const database = options.database ?? getDb();
  if (labels.length > MAX_LABELS) throw new ApiError(400, 'validation_error', `at most ${MAX_LABELS} labels`);
  const set = await mustPublish(account, setId, database);
  const generation = writableGeneration(set, options.generation);
  const spec = (await setSignals(setId, database)).find((s) => s.name === signal);
  if (!spec) throw new ApiError(404, 'not_found', `${setId} has no signal "${signal}"`);
  if (spec.kind !== 'label') throw new ApiError(422, 'validation_error', `${signal} is a ${spec.kind}, not a label`);
  await database.transaction(async (tx) => {
    await tx
      .delete(signalLabels)
      .where(
        and(eq(signalLabels.setId, setId), eq(signalLabels.generation, generation), eq(signalLabels.signal, signal)),
      );
    for (let i = 0; i < labels.length; i += 1000) {
      await tx
        .insert(signalLabels)
        .values(labels.slice(i, i + 1000).map((l) => ({ setId, generation, signal, key: l.key, title: l.title })))
        .onConflictDoNothing();
    }
    if (generation === set.liveGeneration) {
      await tx
        .update(signalSets)
        .set({ changedAt: sql`clock_timestamp()` })
        .where(eq(signalSets.id, setId));
    }
  });
  return { generation, labels: labels.length };
}

/** A set's version for caches: its live generation and when it last changed. */
export function signalEtagOf(set: Pick<SetRow, 'id' | 'liveGeneration' | 'changedAt'>, ...rest: unknown[]): string {
  return JSON.stringify([set.id, set.liveGeneration, set.changedAt.toISOString(), ...rest]);
}

export interface SignalColumns {
  set: { id: string; name: string; generation: number };
  /** Each paper's identifier, as its publisher gave it; index `i` of every column is this paper. */
  papers: string[];
  titles?: string[];
  signals: Record<
    string,
    | { kind: 'vector'; dims: number; values: (number | null)[] }
    | { kind: 'number'; values: (number | null)[] }
    | { kind: 'label'; keys: string[]; titles: (string | null)[]; values: (number | null)[] }
  >;
}

/**
 * Some of a set's signals for every paper on this site that has one, by column: the map's whole input in one read.
 * A vector's column is flat (`dims` numbers a paper). A label's values are indexes into `keys`, with each key's title.
 * `scope` keeps only a venue's, category's or org's papers (with its roll-up).
 */
export async function signalColumns(
  setId: string,
  names: string[],
  options: { scopeId?: string; titles?: boolean; database?: Db } = {},
): Promise<SignalColumns> {
  const database = options.database ?? getDb();
  const set = await mustFindSet(setId, database);
  const all = await setSignals(setId, database);
  const wanted = names.length ? names : all.map((s) => s.name);
  const specs = wanted.map((name) => {
    const found = all.find((s) => s.name === name);
    if (!found) throw new ApiError(404, 'not_found', `${setId} has no signal "${name}"`);
    return found;
  });
  const { rows } = await database.execute<{
    signal: string;
    scheme: string;
    value: string;
    paper_id: string;
    title: string;
    num: number | null;
    label: string | null;
    vec: number[] | null;
  }>(sql`
    select v.signal, v.scheme, v.value, coalesce(p.merged_into, p.id) as paper_id, p.title, v.num, v.label, v.vec
      from signal_values v
      join paper_identifiers i on i.scheme = v.scheme and i.value = v.value
      join papers p on p.id = i.paper_id
     where v.set_id = ${setId} and v.generation = ${set.liveGeneration} and v.signal in ${wanted}
       ${
         options.scopeId
           ? sql`and exists (select 1 from page_members m where m.paper_id = coalesce(p.merged_into, p.id)
                    and m.scope_page_id in (${scopePagesOf(options.scopeId)}))`
           : sql``
       }
     order by v.scheme, v.value
  `);
  const index = new Map<string, number>();
  const papers: string[] = [];
  const titles: string[] = [];
  for (const row of rows) {
    if (index.has(row.paper_id)) continue;
    index.set(row.paper_id, papers.length);
    papers.push(formatIdentifier({ kind: 'paper', id: { scheme: row.scheme as 'openreview', value: row.value } }));
    titles.push(row.title);
  }
  const n = papers.length;
  const labelRows = await database
    .select()
    .from(signalLabels)
    .where(
      and(
        eq(signalLabels.setId, setId),
        eq(signalLabels.generation, set.liveGeneration),
        inArray(
          signalLabels.signal,
          specs.filter((s) => s.kind === 'label').map((s) => s.name),
        ),
      ),
    );
  const out: SignalColumns['signals'] = {};
  for (const { name, spec } of specs) {
    const mine = rows.filter((r) => r.signal === name);
    if (spec.kind === 'vector') {
      const values: (number | null)[] = new Array(n * spec.dims).fill(null);
      for (const r of mine) {
        const at = index.get(r.paper_id)! * spec.dims;
        r.vec?.forEach((x, d) => (values[at + d] = Math.round(x * 1e4) / 1e4));
      }
      out[name] = { kind: 'vector', dims: spec.dims, values };
    } else if (spec.kind === 'number') {
      const values: (number | null)[] = new Array(n).fill(null);
      for (const r of mine) values[index.get(r.paper_id)!] = r.num;
      out[name] = { kind: 'number', values };
    } else {
      const named = new Map(labelRows.filter((l) => l.signal === name).map((l) => [l.key, l.title]));
      const keys: string[] = [];
      const keyIndex = new Map<string, number>();
      const values: (number | null)[] = new Array(n).fill(null);
      for (const r of mine) {
        if (r.label === null) continue;
        let k = keyIndex.get(r.label);
        if (k === undefined) keyIndex.set(r.label, (k = keys.push(r.label) - 1));
        values[index.get(r.paper_id)!] = k;
      }
      out[name] = { kind: 'label', keys, titles: keys.map((k) => named.get(k) ?? null), values };
    }
  }
  return {
    set: { id: set.id, name: set.name, generation: set.liveGeneration },
    papers,
    ...(options.titles ? { titles } : {}),
    signals: out,
  };
}

/** One paper's values in every set (or one), live generations only, each named by its set. */
export async function paperSignals(paperId: string, setId?: string, database: Database = getDb()) {
  const { rows } = await database.execute<{
    set_id: string;
    set_name: string;
    signal: string;
    kind: string;
    spec: SignalSpec;
    num: number | null;
    label: string | null;
    label_title: string | null;
    vec: number[] | null;
  }>(sql`
    select v.set_id, s.name as set_name, v.signal, g.kind, g.spec, v.num, v.label, l.title as label_title, v.vec
      from paper_identifiers i
      join papers p on p.id = i.paper_id
      join signal_values v on v.scheme = i.scheme and v.value = i.value
      join signal_sets s on s.id = v.set_id and s.live_generation = v.generation
      join signals g on g.set_id = v.set_id and g.name = v.signal
      left join signal_labels l on l.set_id = v.set_id and l.generation = v.generation and l.signal = v.signal
                                and l.key = v.label
     where coalesce(p.merged_into, p.id) = ${paperId}::uuid
       ${setId ? sql`and v.set_id = ${setId}` : sql``}
     order by v.set_id, v.signal
  `);
  const sets = new Map<string, { id: string; name: string; values: Record<string, unknown> }>();
  for (const r of rows) {
    let entry = sets.get(r.set_id);
    if (!entry) sets.set(r.set_id, (entry = { id: r.set_id, name: r.set_name, values: {} }));
    if (entry.values[r.signal] !== undefined) continue;
    entry.values[r.signal] =
      r.kind === 'vector'
        ? { kind: 'vector', value: r.vec }
        : r.kind === 'number'
          ? { kind: 'number', value: r.num, title: r.spec.title }
          : { kind: 'label', value: r.label, title: r.label_title };
  }
  return [...sets.values()];
}

interface VectorIndex {
  etag: string;
  dims: number;
  paperIds: string[];
  /** Each paper's row, by paper id. */
  byPaperId: Map<string, number>;
  identifiers: string[];
  titles: string[];
  /** Unit vectors, `dims` numbers each (cosine); raw for `dot` and `l2`. */
  data: Float32Array;
  metric: 'cosine' | 'dot' | 'l2';
}

const indexes = new Map<string, Promise<VectorIndex>>();

/** A vector signal's live values in memory, rebuilt when the set changes: fine for tens of thousands of papers. */
async function vectorIndex(set: SetRow, signal: string, database: Db): Promise<VectorIndex> {
  const etag = signalEtagOf(set, signal);
  const key = `${set.id}:${signal}`;
  const cached = indexes.get(key);
  if (cached) {
    const found = await cached.catch(() => null);
    if (found?.etag === etag) return found;
  }
  const spec = (await setSignals(set.id, database)).find((s) => s.name === signal)?.spec;
  if (!spec) throw new ApiError(404, 'not_found', `${set.id} has no signal "${signal}"`);
  if (spec.kind !== 'vector') throw new ApiError(422, 'validation_error', `${signal} is a ${spec.kind}, not a vector`);
  const work = (async () => {
    const columns = await signalColumns(set.id, [signal], { titles: true, database });
    const column = columns.signals[signal] as { dims: number; values: (number | null)[] };
    const keep: number[] = [];
    for (let i = 0; i < columns.papers.length; i++) {
      if (column.values[i * spec.dims] !== null) keep.push(i);
    }
    const data = new Float32Array(keep.length * spec.dims);
    keep.forEach((i, row) => {
      let norm = 0;
      for (let d = 0; d < spec.dims; d++) norm += (column.values[i * spec.dims + d] as number) ** 2;
      const scale = spec.metric === 'cosine' && norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let d = 0; d < spec.dims; d++) {
        data[row * spec.dims + d] = (column.values[i * spec.dims + d] as number) * scale;
      }
    });
    const { rows } = await database.execute<{ scheme: string; value: string; paper_id: string }>(sql`
      select i.scheme, i.value, coalesce(p.merged_into, p.id) as paper_id
        from paper_identifiers i join papers p on p.id = i.paper_id
       where (i.scheme, i.value) in (select scheme, value from signal_values
                                      where set_id = ${set.id} and generation = ${set.liveGeneration}
                                        and signal = ${signal})
    `);
    const byIdentifier = new Map(rows.map((r) => [`${r.scheme}:${r.value}`, r.paper_id]));
    const identifiers = keep.map((i) => columns.papers[i]);
    const paperIds = identifiers.map((id) => byIdentifier.get(id) ?? '');
    const byPaperId = new Map<string, number>();
    paperIds.forEach((id, i) => {
      if (id && !byPaperId.has(id)) byPaperId.set(id, i);
    });
    return {
      etag,
      dims: spec.dims,
      metric: spec.metric,
      identifiers,
      titles: keep.map((i) => columns.titles![i]),
      paperIds,
      byPaperId,
      data,
    };
  })();
  indexes.set(key, work);
  work.catch(() => indexes.delete(key));
  return work;
}

export interface Neighbour {
  paper: string;
  title: string;
  score: number;
  /** With `with`: its values of those signals (a label's key), `null` where it has none. */
  values?: Record<string, unknown>;
}

/** The `k` best of `n` scores, best first, without sorting them all: one pass keeping a small sorted list. */
export function topK(scores: Float32Array, k: number, skip: (i: number) => boolean): number[] {
  const best: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (skip(i)) continue;
    const s = scores[i];
    if (best.length === k && s <= scores[best[k - 1]]) continue;
    let at = best.length;
    while (at > 0 && scores[best[at - 1]] < s) at--;
    best.splice(at, 0, i);
    if (best.length > k) best.pop();
  }
  return best;
}

/** Some signals' values for some papers (by identifier), live generation, with the titles of the labels among them. */
async function valuesOf(set: SetRow, papers: string[], names: string[], database: Db) {
  const out = new Map<string, Record<string, unknown>>(
    papers.map((p) => [p, Object.fromEntries(names.map((n) => [n, null]))]),
  );
  const labels: Record<string, Record<string, string>> = {};
  if (papers.length === 0 || names.length === 0) return { values: out, labels };
  const keys = papers.map((p) => paperKey(p)!);
  const { rows } = await database.execute<{
    signal: string;
    scheme: string;
    value: string;
    num: number | null;
    label: string | null;
    vec: number[] | null;
    title: string | null;
  }>(sql`
    select v.signal, v.scheme, v.value, v.num, v.label, v.vec, l.title
      from signal_values v
      left join signal_labels l on l.set_id = v.set_id and l.generation = v.generation and l.signal = v.signal
                                and l.key = v.label
     where v.set_id = ${set.id} and v.generation = ${set.liveGeneration} and v.signal in ${names}
       and (v.scheme, v.value) in (${sql.join(
         keys.map((k) => sql`(${k.scheme}, ${k.value})`),
         sql`, `,
       )})
  `);
  for (const r of rows) {
    const entry = out.get(`${r.scheme}:${r.value}`);
    if (!entry) continue;
    entry[r.signal] = r.vec ?? r.num ?? r.label;
    if (r.label !== null && r.title !== null) (labels[r.signal] ??= {})[r.label] = r.title;
  }
  return { values: out, labels };
}

/**
 * The `k` papers nearest a paper by one of a set's vector signals, best first, without the paper itself. `with` names
 * other signals of the set to send for the paper and each neighbour (a map's `map.xy` and `map.cluster`, so a minimap
 * draws from this answer alone), and `labels` the titles of the label values among them.
 */
export async function nearestPapers(
  setId: string,
  signal: string,
  paperId: string,
  k: number,
  options: { with?: string[]; database?: Db } = {},
): Promise<{
  paper: string | null;
  values?: Record<string, unknown>;
  neighbours: Neighbour[];
  labels?: Record<string, Record<string, string>>;
}> {
  const database = options.database ?? getDb();
  const set = await mustFindSet(setId, database);
  const index = await vectorIndex(set, signal, database);
  const self = index.byPaperId.get(paperId);
  if (self === undefined) return { paper: null, neighbours: [] };
  const { dims, data } = index;
  const n = index.paperIds.length;
  const scores = new Float32Array(n);
  const base = self * dims;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const at = i * dims;
    if (index.metric === 'l2') {
      for (let d = 0; d < dims; d++) s -= (data[at + d] - data[base + d]) ** 2;
    } else {
      for (let d = 0; d < dims; d++) s += data[at + d] * data[base + d];
    }
    scores[i] = s;
  }
  const order = topK(scores, k, (i) => i === self || index.paperIds[i] === paperId);
  const neighbours: Neighbour[] = order.map((i) => ({
    paper: index.identifiers[i],
    title: index.titles[i],
    score: Math.round(scores[i] * 1e4) / 1e4,
  }));
  const paper = index.identifiers[self];
  if (!options.with?.length) return { paper, neighbours };
  const known = new Set((await setSignals(set.id, database)).map((s) => s.name));
  const unknown = options.with.filter((name) => !known.has(name));
  if (unknown.length) throw new ApiError(404, 'not_found', `${set.id} has no signal "${unknown[0]}"`);
  const { values, labels } = await valuesOf(set, [paper, ...neighbours.map((x) => x.paper)], options.with, database);
  for (const x of neighbours) x.values = values.get(x.paper);
  return { paper, values: values.get(paper), neighbours, labels };
}

const HAS_SIGNALS_TTL_MS = 10 * 60_000;
const hasSignalsCache = new Map<string, { at: number; value: Promise<boolean> }>();

/**
 * `page.hasSignals`: whether a paper has a value in any set's live generation, or a scope has a paper that does. A
 * plugin that draws signals shows its panel only there, so pages without any start no frame and fetch nothing. Kept
 * ten minutes per page, as a scope's answer can take a scan of its members.
 */
export function pageHasSignals(page: { id: string; kind: string }, database: Db = getDb()): Promise<boolean> {
  const cached = hasSignalsCache.get(page.id);
  if (cached && Date.now() - cached.at < HAS_SIGNALS_TTL_MS) return cached.value;
  const live = sql`join signal_values v on v.scheme = i.scheme and v.value = i.value
                   join signal_sets s on s.id = v.set_id and s.live_generation = v.generation`;
  const query =
    page.kind === 'paper'
      ? sql`select exists (select 1 from papers p join paper_identifiers i on i.paper_id = p.id ${live}
                            where coalesce(p.merged_into, p.id) = ${page.id}::uuid) as found`
      : sql`select exists (select 1 from page_members m join paper_identifiers i on i.paper_id = m.paper_id ${live}
                            where m.scope_page_id in (${scopePagesOf(page.id)})) as found`;
  const value = database.execute<{ found: boolean }>(query).then((r) => Boolean(r.rows[0]?.found));
  hasSignalsCache.set(page.id, { at: Date.now(), value });
  value.catch(() => hasSignalsCache.delete(page.id));
  if (hasSignalsCache.size > 20_000) hasSignalsCache.delete(hasSignalsCache.keys().next().value!);
  return value;
}
