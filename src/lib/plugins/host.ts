import { z } from 'zod';
import { parseIdentifier } from '../kinds';
import { PLUGIN_ID_RE, sanitizeSettingValue, type PluginSettingSpec } from '../settings/spec';
import {
  type CallEnvelope,
  errorOf,
  type ErrorCode,
  eventOf,
  type FrameContext,
  type FrameEvent,
  HOST_METHODS,
  type HostMethod,
  type IdentityToken,
  isEnvelope,
  MAX_FRAME_HEIGHT,
  MAX_PAPERS_CHUNK,
  MAX_ROW_NOTE_TEXT,
  MAX_ROW_NOTE_TITLE,
  MAX_ROW_NOTES,
  PAPER_FIELDS,
  PROTOCOL_VERSION,
  resultOf,
  ROW_NOTE_TONES,
  type RowNote,
  STORAGE_KEY_RE,
} from './protocol';

/**
 * The page's side of the RPC (`protocol.ts`): one connection per running frame, over the port the frame was booted
 * with. Every call is checked here: the method must exist, the permission it needs must be one the reader granted,
 * and its params must fit. What a call does is up to the `HostServices` the page gives (`PluginFrame.tsx`), so this
 * file has no React and no fetch, and the tests drive it with a `MessageChannel`.
 */

export class HostError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface HostServices {
  context(): FrameContext;
  /** The permissions the reader granted this plugin (for a site default or a dev plugin, what it asks for). */
  permissions: readonly string[];
  /** The plugin's declared settings, to check `settings.set`. */
  settingSpecs: Record<string, PluginSettingSpec>;
  /** The plugin's own settings, by name. */
  settings(): Record<string, unknown>;
  setSetting(name: string, value: unknown): Promise<void>;
  storageGet(): Promise<Record<string, unknown>>;
  storageSet(key: string, value: unknown): Promise<void>;
  /** A GET of the site's public API: `/pages/<identifier>/files`, …; rejects with a `HostError`. */
  api(path: string): Promise<unknown>;
  /**
   * A GET of one of the API's NDJSON routes (`/pages/<identifier>/papers?limit=…`): its lines, parsed, and the cursor of
   * the chunk after (`X-Next-Cursor`), `null` at the end.
   */
  apiLines(path: string): Promise<{ rows: unknown[]; next: string | null }>;
  /**
   * A token naming the signed-in reader to the plugin's backend (`POST /me/plugins/identity`); rejects with
   * `Unavailable` when the reader is signed out.
   */
  identityToken(): Promise<IdentityToken>;
  setHeight(height: number): void;
  openUrl(url: string): void;
  /**
   * On a plugin's own page, the rest of its address after `/x/<owner>/<name>/<page>/` (`surface.path`), replaced in the
   * address bar without a reload, so what the reader is looking at can be shared. Rejects in a panel.
   */
  setPath(path: string[]): void;
  /** On a list's frames: set notes on its rows, by paper identifier (`null` removes one). */
  setRowNotes?(notes: Record<string, RowNote | null>): void;
  /** A popover's frame: close it. Elsewhere nothing. */
  close?(): void;
}

const identifier = z
  .string()
  .max(400)
  .refine((text) => parseIdentifier(text) !== null, 'not a page identifier');

/** A signal set's id, `<owner>/<name>` (`handoffs/signals.md`). */
const setId = z.string().regex(PLUGIN_ID_RE, 'a set id is "<owner>/<name>"');

const PARAMS: Partial<Record<HostMethod, z.ZodType>> = {
  'settings.set': z.object({ name: z.string().max(100), value: z.unknown() }),
  'storage.get': z.object({ key: z.string().regex(STORAGE_KEY_RE).optional() }),
  'storage.set': z.object({ key: z.string().regex(STORAGE_KEY_RE), value: z.unknown() }),
  'page.read': z.object({ identifier }),
  'page.members': z.object({
    identifier,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    rollUp: z.boolean().optional(),
  }),
  'page.resolve': z.object({ identifier }),
  'reviews.forPaper': z.object({ identifier }),
  'scope.scores': z
    .object({
      identifier,
      venue: z.string().min(1).max(300).optional(),
      field: z.string().min(1).max(200).optional(),
      marks: z.boolean().optional(),
    })
    .refine((p) => !p.field || p.venue, { message: 'a field needs its venue', path: ['field'] })
    .refine((p) => !p.marks || p.field, { message: 'marks are of one field', path: ['marks'] }),
  'scope.papers': z.object({
    identifier,
    fields: z.array(z.enum(PAPER_FIELDS)).max(PAPER_FIELDS.length).optional(),
    after: z.uuid().optional(),
    limit: z.number().int().min(1).max(MAX_PAPERS_CHUNK).optional(),
  }),
  'signals.set': z.object({ set: setId }),
  'signals.columns': z.object({
    set: setId,
    signals: z.array(z.string().min(1).max(200)).max(20).optional(),
    scope: identifier.optional(),
    titles: z.boolean().optional(),
  }),
  'signals.nearest': z.object({
    set: setId,
    signal: z.string().min(1).max(200),
    paper: identifier,
    k: z.number().int().min(1).max(200).optional(),
    with: z.array(z.string().min(1).max(200)).max(10).optional(),
  }),
  'signals.forPaper': z.object({ paper: identifier, set: setId.optional() }),
  'rows.set': z.object({
    notes: z
      .record(
        z
          .string()
          .max(400)
          .refine((text) => parseIdentifier(text)?.kind === 'paper', "not a paper's identifier"),
        z
          .object({
            text: z.string().trim().min(1).max(MAX_ROW_NOTE_TEXT),
            title: z.string().max(MAX_ROW_NOTE_TITLE).optional(),
            tone: z.enum(ROW_NOTE_TONES).optional(),
          })
          .nullable(),
      )
      .refine((notes) => Object.keys(notes).length <= MAX_ROW_NOTES, `at most ${MAX_ROW_NOTES} notes a call`),
  }),
  'ui.setHeight': z.object({ height: z.number().finite().min(0) }),
  'ui.openUrl': z.object({ url: z.url({ protocol: /^https?$/ }).max(2000) }),
  'ui.setPath': z.object({ path: z.array(z.string().min(1).max(200)).max(10) }),
};

const enc = encodeURIComponent;

type Handler = (services: HostServices, params: Record<string, unknown>) => Promise<unknown> | unknown;

const HANDLERS: Record<HostMethod, Handler> = {
  'context.get': (s) => s.context(),
  'settings.get': (s) => s.settings(),
  'settings.set': async (s, { name, value }) => {
    const key = name as string;
    const spec = Object.hasOwn(s.settingSpecs, key) ? s.settingSpecs[key] : undefined;
    if (!spec) throw new HostError('InvalidParams', `the plugin declares no setting "${key}"`);
    if (value !== null && sanitizeSettingValue(spec, value) === undefined) {
      throw new HostError('InvalidParams', `${JSON.stringify(value)} isn't a value of "${key}"`);
    }
    await s.setSetting(key, value);
  },
  'storage.get': async (s, { key }) => {
    const data = await s.storageGet();
    return key === undefined ? data : (data[key as string] ?? null);
  },
  'storage.set': (s, { key, value }) => s.storageSet(key as string, value ?? null),
  'page.read': (s, { identifier }) => s.api(`/pages/${enc(identifier as string)}/files`),
  'page.members': (s, { identifier, offset, limit, rollUp }) => {
    const query = new URLSearchParams();
    if (offset !== undefined) query.set('offset', String(offset));
    if (limit !== undefined) query.set('limit', String(limit));
    if (rollUp !== undefined) query.set('rollUp', String(rollUp));
    return s.api(`/pages/${enc(identifier as string)}/members${query.size ? `?${query}` : ''}`);
  },
  'page.resolve': (s, { identifier }) => s.api(`/pages/${enc(identifier as string)}`),
  'reviews.forPaper': (s, { identifier }) => s.api(`/pages/${enc(identifier as string)}/submissions`),
  'scope.scores': async (s, { identifier, venue, field, marks }) => {
    const base = `/pages/${enc(identifier as string)}/scores`;
    if (field) return s.api(`${base}/${enc(venue as string)}/${enc(field as string)}${marks ? '?marks=true' : ''}`);
    const list = (await s.api(base)) as { scores: { venue: { id: string } }[] };
    return venue ? { ...list, scores: list.scores.filter((score) => score.venue.id === venue) } : list;
  },
  'scope.papers': (s, { identifier, fields, after, limit }) => {
    const query = new URLSearchParams({ limit: String(limit ?? 500) });
    if (fields !== undefined) query.set('fields', (fields as string[]).join(','));
    if (after !== undefined) query.set('after', after as string);
    return s.apiLines(`/pages/${enc(identifier as string)}/papers?${query}`);
  },
  'identity.token': (s) => s.identityToken(),
  'signals.sets': (s) => s.api('/signal-sets'),
  'signals.set': (s, { set }) => s.api(`/signal-sets/${set as string}`),
  'signals.columns': (s, { set, signals, scope, titles }) => {
    const query = new URLSearchParams();
    if (signals) query.set('signals', (signals as string[]).join(','));
    if (scope) query.set('scope', scope as string);
    if (titles) query.set('titles', 'true');
    return s.api(`/signal-sets/${set as string}/columns${query.size ? `?${query}` : ''}`);
  },
  'signals.nearest': (s, { set, signal, paper, k, with: also }) => {
    const query = new URLSearchParams({ signal: signal as string, paper: paper as string });
    if (k !== undefined) query.set('k', String(k));
    if (also) query.set('with', (also as string[]).join(','));
    return s.api(`/signal-sets/${set as string}/nearest?${query}`);
  },
  'signals.forPaper': (s, { paper, set }) =>
    s.api(`/pages/${enc(paper as string)}/signals${set ? `?set=${enc(set as string)}` : ''}`),
  'rows.set': (s, { notes }) => {
    if (!s.setRowNotes) throw new HostError('Unavailable', "this frame isn't on a list (contributes.rows)");
    s.setRowNotes(notes as Record<string, RowNote | null>);
  },
  'ui.setHeight': (s, { height }) => s.setHeight(Math.min(MAX_FRAME_HEIGHT, Math.round(height as number))),
  'ui.openUrl': (s, { url }) => s.openUrl(url as string),
  'ui.setPath': (s, { path }) => s.setPath(path as string[]),
  'ui.close': (s) => s.close?.(),
};

export async function dispatch(services: HostServices, call: CallEnvelope) {
  if (!Object.hasOwn(HOST_METHODS, call.method)) {
    return errorOf(call, 'MethodNotFound', `no method "${call.method}" (the plugin may be newer than this site)`);
  }
  const method = call.method as HostMethod;
  const permission = HOST_METHODS[method];
  if (permission && !services.permissions.includes(permission)) {
    return errorOf(
      call,
      'PermissionDenied',
      `${method} needs the "${permission}" permission: list it in the manifest's "permissions", and the reader approves it`,
    );
  }
  const schema = PARAMS[method];
  let params: Record<string, unknown> = {};
  if (schema) {
    const parsed = schema.safeParse(call.params ?? {});
    if (!parsed.success) {
      return errorOf(
        call,
        'InvalidParams',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
      );
    }
    params = parsed.data as Record<string, unknown>;
  }
  try {
    return resultOf(call, (await HANDLERS[method](services, params)) ?? null);
  } catch (e) {
    if (e instanceof HostError) return errorOf(call, e.code, e.message);
    console.warn(`plugin: ${method} failed`, e);
    return errorOf(call, 'Internal', e instanceof Error ? e.message : String(e));
  }
}

export interface Connection {
  emit(event: FrameEvent, params?: unknown): void;
  /** Call the frame (`commands.run`); rejects if it doesn't answer in time. */
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/** Answer a booted frame's calls on its port, until closed. */
export function connect(port: MessagePort, services: HostServices): Connection {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  port.onmessage = async (event: MessageEvent) => {
    const message = event.data;
    if (!isEnvelope(message)) return;
    if (message.kind === 'call') {
      port.postMessage(await dispatch(services, message));
    } else if (message.kind === 'result' || message.kind === 'error') {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.kind === 'result') waiting.resolve(message.result);
      else waiting.reject(new HostError(message.error.code, message.error.message));
    }
  };
  return {
    emit(event, params) {
      port.postMessage(eventOf(event, params));
    },
    call(method, params, timeoutMs = 10_000) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new HostError('Unavailable', `the plugin didn't answer ${method} in time`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        port.postMessage({ v: PROTOCOL_VERSION, kind: 'call', id, method, params } satisfies CallEnvelope);
      });
    },
    close() {
      port.onmessage = null;
      port.close();
      for (const waiting of pending.values()) waiting.reject(new HostError('Unavailable', 'the frame closed'));
      pending.clear();
    },
  };
}
