import type { PageKind } from '../kinds';
import type { PluginPermission } from './manifest';

/**
 * The wire protocol between a plugin's frame (the SDK, `public/sdk/v1/pp.js`) and the page that hosts it
 * (`host.ts`, `components/plugins/PluginFrame.tsx`). It is the plugin's only bridge to the site: a plugin never
 * touches the host's DOM or session, and every call is checked against the permissions the reader granted.
 *
 * Boot is a handshake over window messages: the frame posts `potentialpaper:hello` to its parent, and the host,
 * having checked that the message comes from that frame's window and the plugin's origin, answers with
 * `potentialpaper:boot` carrying a `MessagePort` and the frame's context. Everything after travels over the port as
 * envelopes, in both directions (Presio's format):
 *
 *     { v: 1, kind: "call",   id, method, params }   ask the other side to do something
 *     { v: 1, kind: "result", id, method, result }   …and its answer
 *     { v: 1, kind: "error",  id, method, error }    …or why it couldn't ({ code, message })
 *     { v: 1, kind: "event",      method, params }   a notification; nothing comes back
 *
 * Versioned twice: `v` is the envelope format, `API_VERSION` (manifest.ts) the methods. Methods are only ever
 * added within an API version; a plugin checks `pp.supports(method)` before using a newer one.
 */

export const PROTOCOL_VERSION = 1;

export const HELLO_MESSAGE = 'potentialpaper:hello';
export const BOOT_MESSAGE = 'potentialpaper:boot';

export type EnvelopeKind = 'call' | 'result' | 'error' | 'event';

export interface CallEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: 'call';
  id: number;
  method: string;
  params?: unknown;
}
export interface ResultEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: 'result';
  id: number;
  method: string;
  result?: unknown;
}
export interface ErrorEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: 'error';
  id: number;
  method: string;
  error: { code: ErrorCode; message: string };
}
export interface EventEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: 'event';
  method: string;
  params?: unknown;
}
export type Envelope = CallEnvelope | ResultEnvelope | ErrorEnvelope | EventEnvelope;

/** Why a call failed. A plugin can branch on these; the message is for people. */
export const ERROR_CODES = [
  /** No such method: a typo, or a newer API than this host has. */
  'MethodNotFound',
  /** The reader didn't grant the permission the method needs (or the manifest doesn't ask for it). */
  'PermissionDenied',
  /** The params don't fit the method. */
  'InvalidParams',
  /** Not here, not now: no such page, or the reader isn't signed in for something that needs it. */
  'Unavailable',
  /** It went wrong on the host's side. */
  'Internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Calls a frame makes to the host, each with the permission it needs (`null`: none). What `pp.supports()` answers.
 */
export const HOST_METHODS = {
  'context.get': null,
  'settings.get': null,
  'settings.set': null,
  'storage.get': null,
  'storage.set': null,
  'page.read': 'page.read',
  'page.members': 'scope.read',
  'page.resolve': null,
  'reviews.forPaper': 'reviews.read',
  'scope.scores': 'scope.read',
  'scope.papers': 'scope.read',
  'identity.token': 'identity',
  'signals.sets': null,
  'signals.set': null,
  'signals.columns': null,
  'signals.nearest': null,
  'signals.forPaper': null,
  'ui.setHeight': null,
  'ui.openUrl': null,
  'ui.setPath': null,
} as const satisfies Record<string, PluginPermission | null>;
export type HostMethod = keyof typeof HOST_METHODS;

/** Events the host sends a frame. */
export type FrameEvent = 'settings.change' | 'theme.change' | 'context.change' | 'surface.resize';

/** Calls the host makes to a frame: `commands.run` `{ command }`, when the reader picks one from a panel's menu. */
export type FrameMethod = 'commands.run';

/** One plugin's storage, as JSON: what `storage.set` may keep per account and plugin. */
export const MAX_STORAGE_BYTES = 64 * 1024;
/** A storage key. */
export const STORAGE_KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** The most papers one `scope.papers` call returns; the SDK asks for chunks of this size until the end. */
export const MAX_PAPERS_CHUNK = 2000;
/** The fields `scope.papers` can give each paper (`GET /pages/{identifier}/papers?fields=`). */
export const PAPER_FIELDS = ['submissions', 'scores', 'status'] as const;

/**
 * What `identity.token` gives (`server/plugins/identity.ts`): a JWT naming the reader to the plugin's own backend,
 * which checks it against `jwksUrl` with `issuer` and `audience` (the plugin's id).
 */
export interface IdentityToken {
  token: string;
  expiresAt: string;
  audience: string;
  issuer: string;
  /** The reader's subject for this plugin (`sub`): stable, and different for every plugin. */
  subject: string;
  handle: string;
  jwksUrl: string;
}

/** The tallest a frame may make itself. */
export const MAX_FRAME_HEIGHT = 4000;

/** The design tokens a frame gets, so it can match the page in light and dark (`globals.css`). */
export const THEME_TOKENS = [
  'bg',
  'ink',
  'muted',
  'faint',
  'rule',
  'rule-soft',
  'highlight',
  'tint',
  'accent',
  'up',
  'down',
  'card',
  'font-serif',
  'font-sans',
  'font-mono',
] as const;

export interface Theme {
  mode: 'light' | 'dark';
  /** Each token's CSS value, by name: `{ ink: '#1d1d1d', … }`. Also set on the frame's `:root` by the SDK, as `--pp-<name>`. */
  tokens: Record<string, string>;
}

/** A page as plugins see it: its kind, identifier and address, and what it's called. */
export interface PageSummary {
  kind: PageKind;
  /** Its public identifier, as a link's `to` holds it: `venue:iclr/2027`, `arxiv:1706.03762`. */
  identifier: string;
  /** Its path on the site. */
  address: string;
  /** Its absolute URL. */
  url: string;
  name: string;
}

/** A frame's size, in CSS pixels. */
export interface FrameSize {
  width: number;
  height: number;
}

/** What a frame knows when it starts (`pp.context`), and gets again from `context.get`. */
export interface FrameContext {
  plugin: { id: string; name: string; version: string; sha: string | null; dev: boolean };
  /**
   * The panel the frame draws, or the plugin page it is, and its size in CSS pixels when the context was made. The
   * `surface.resize` event (`pp.ui.onResize`) gives the size again whenever it changes.
   */
  surface:
    | {
        type: 'panel';
        panel: string;
        /** Its slot's full name: `paper.community`. */
        slot: string;
        /** Where it sits, as a manifest's `slot` names places: `main`, `aside`, `tab`, `body`, `submission`, `community`, `author`. */
        place: string;
        size: FrameSize;
        /** In the `paper.submission` slot: the submission it is drawn under, by its venue (`openreview:ICLR.cc/2027/Conference`). */
        submission?: { venue: { id: string; name: string } };
        /** In the `paper.author` slot: what the paper's authors set for it in `author/plugins.json`. */
        config?: Record<string, unknown>;
      }
    | { type: 'page'; page: string; path: string[]; size: FrameSize };
  /** The page the panel is on; `null` on a plugin's own page. */
  page: PageSummary | null;
  /**
   * The pages above it: a paper's venues, topics and orgs; a topic's broader topics; an org's parents; an edition's
   * series.
   */
  scopes: PageSummary[];
  viewer: { signedIn: boolean; isOwner: boolean };
  theme: Theme;
  /** The plugin's own settings, by name (without the plugin id), as they resolve for the reader. */
  settings: Record<string, unknown>;
  /** The site's origin, for links. */
  site: string;
  /** The methods this host answers. */
  methods: string[];
}

/** An envelope's shape, checked loosely: what arrives on a port is untrusted. */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.v === PROTOCOL_VERSION && typeof m.kind === 'string' && typeof m.method === 'string';
}

export function resultOf(call: CallEnvelope, result: unknown): ResultEnvelope {
  return { v: PROTOCOL_VERSION, kind: 'result', id: call.id, method: call.method, result };
}

export function errorOf(call: CallEnvelope, code: ErrorCode, message: string): ErrorEnvelope {
  return { v: PROTOCOL_VERSION, kind: 'error', id: call.id, method: call.method, error: { code, message } };
}

export function eventOf(method: string, params?: unknown): EventEnvelope {
  return { v: PROTOCOL_VERSION, kind: 'event', method, params };
}
