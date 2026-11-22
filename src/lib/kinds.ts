import { z } from 'zod';
import {
  canonicalPaperId,
  PAPER_SCHEMES,
  PATH_PREFIX,
  paperPath,
  shortPath,
  parsePaperId,
  type PaperId,
  type PaperScheme,
} from './paper-ids';
import { HANDLE_PATTERN } from './profile';

/**
 * The kinds of page (`handoffs/pages.md`): a paper, a venue, a topic, an organisation or a person. Every kind is a
 * page repo built the same way (DESIGN.md §4): small files under path rules, derived data from outbox consumers,
 * named slots, and file types that bots write and plugins show. A kind is an entry here, plus its routes; the page
 * store, the path rules (`server/pages/rules.ts`), clone and push, and the consumers read what it declares.
 *
 * Each kind declares
 *
 * - **its address form**: the public identifier (`venue:iclr/2027`, what a link's `to` holds, DESIGN.md §8) and the
 *   page's path on the site (`/v/iclr/2027`). A paper's are its `paper_identifiers` (`arxiv:…`, `doi:…`), as before;
 *   every other kind's are made from its `key`, the `pages.key` column;
 * - **its kind file** and that file's schema: what the page is (`venue.json`: name, dates, sources);
 * - **its parts**: the folders of sections people write, `owners/` (where the kind has owners: a paper's authors, a
 *   venue's organisers, an org's members, a person) and `community/`, each also holding that part's `links.jsonl`.
 *   Who may write which is in `rules.ts`;
 * - **how its owners are confirmed** (`claim`): by an author claim, an organiser claim, an address at its domains,
 *   or being the account; a topic has none;
 * - **its slots**: every kind has `<kind>.main`, `<kind>.aside`, `<kind>.body` and `<kind>.tabs`, and a kind may add
 *   its own;
 * - **which file types it allows** (`server/pages/schemas.ts`);
 * - **the context keys** it offers plugins' `when` conditions (`handoffs/plugins.md` Phase 2);
 * - **whether it is a scope**: a page with members (papers), whose lists, counts and statistics read
 *   `page_members`, rolled up through `page_ancestors` from its **parents**.
 *
 * Pure, and shared by the server and the browser.
 */

export const PAGE_KINDS = ['paper', 'venue', 'topic', 'org', 'user'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export function isPageKind(value: string): value is PageKind {
  return (PAGE_KINDS as readonly string[]).includes(value);
}

/** A lower-case slug, as a topic's key, or one segment of a venue's or an org's. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SEGMENT = 60;

const shortText = (max: number) => z.string().trim().min(1).max(max);
const https = z.url({ protocol: /^https$/ }).max(500);
const slugList = (description: string) =>
  z
    .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/))
    .max(20)
    .optional()
    .meta({ description });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD');

/** A `venue.json`: a series (`iclr`), an edition (`iclr/2027`), or deeper, a track or workshop. */
export const venueFileSchema = z
  .strictObject({
    name: shortText(200).meta({ description: 'The venue as people say it: "ICLR 2027", or "ICLR" for the series.' }),
    dates: z
      .strictObject({ start: date.optional(), end: date.optional() })
      .optional()
      .meta({ description: "An edition's dates, YYYY-MM-DD." }),
    url: https.optional().meta({ description: "The venue's own site." }),
    sources: z
      .array(z.string().regex(/^[a-z0-9-]+:\S+$/, 'a source id, like openreview:ICLR.cc/2027/Conference'))
      .max(20)
      .optional()
      .meta({
        description:
          'Where its submissions come from, as `<source>:<id>`: "openreview:ICLR.cc/2027/Conference". A paper with a submission there is a member.',
      }),
  })
  .meta({
    title: 'Venue',
    description: "A venue page's venue.json: what the venue is, and where its papers come from.",
  });

/**
 * A `topic.json`: a topic's name. A topic works as a Wikipedia category does: pages are in it through their own
 * `in-topic` links, a topic in another one included, which makes it a subtopic there.
 */
export const topicFileSchema = z
  .strictObject({
    name: shortText(120).meta({ description: 'The topic\'s name: "Linear attention".' }),
  })
  .meta({ title: 'Topic', description: "A topic page's topic.json: its name." });

/** An `org.json`: an institution, or a department or lab under one. */
export const orgFileSchema = z
  .strictObject({
    name: shortText(200).meta({ description: 'The organisation\'s name: "ETH Zurich".' }),
    domains: z
      .array(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/))
      .max(20)
      .optional()
      .meta({
        description:
          "Email domains whose confirmed addresses, at the domain or under it, make someone a member, and whose addresses on papers make them its papers: \"ethz.ch\". A department's are its organisation's or under them; a top-level organisation's are changed by admins and the orgs bot.",
      }),
    parents: slugList('Organisations it belongs to besides the one its address is under, by key: "eth".'),
    ror: z
      .string()
      .regex(/^https:\/\/ror\.org\/0[a-z0-9]{8}$/)
      .optional()
      .meta({ description: 'Its ROR id, as https://ror.org/05a28rw58.' }),
  })
  .meta({ title: 'Organisation', description: "An organisation page's org.json." });

export type VenueFile = z.output<typeof venueFileSchema>;
export type TopicFile = z.output<typeof topicFileSchema>;
export type OrgFile = z.output<typeof orgFileSchema>;

/** The generic slots every kind has; a kind may add more (a paper's nested ones). */
export const GENERIC_SLOTS = ['main', 'aside', 'body', 'tabs'] as const;

/** The owners' part, the same folder on every kind that has owners. */
export const OWNERS_DIR = 'owners';

/**
 * How a kind's owners are confirmed: `authors`, a claim on one of the paper's author names (`server/claims.ts`);
 * `organisers`, a claim an admin decides, which holds for the pages under it too (`server/page-claims.ts`);
 * and `domain`, a confirmed address at one of its domains (`server/org-roles.ts`).
 */
export type ClaimPolicy = 'authors' | 'organisers' | 'domain';
export type GenericSlot = (typeof GENERIC_SLOTS)[number];

export interface KindInfo {
  kind: PageKind;
  /** "Venue". */
  title: string;
  /** Where its pages are on the site: `/v`. A paper's are by identifier, `/abs`, `/doi`, `/openreview`. */
  route: string;
  /**
   * Whether its pages have a repo: files, history, a clone address, edits. A person's page has none: it is drawn from
   * their account (`server/user-pages.ts`), which only they change, at `/profile`.
   */
  repo: boolean;
  /** The kind file, from the repo's root; `null` on a kind without a repo. */
  kindFile: string | null;
  /** Its schema; `null` for a paper's, which is the system's snapshot. */
  kindFileSchema: z.ZodType | null;
  /**
   * Its owners, if it has any: what the page calls them ("the authors"), and how they are confirmed. Their part is
   * `owners/` (`OWNERS_DIR`).
   */
  owners: {
    dir: typeof OWNERS_DIR;
    /** "the authors": "From the authors", "Only the authors…". */
    title: string;
    /** Who they are, as a refusal says it: "confirmed authors". */
    noun: string;
    claim: ClaimPolicy;
  } | null;
  /** Whether it has a `community/` part. */
  community: boolean;
  /** Its slots, by full name: `venue.main`. */
  slots: readonly string[];
  /** The file types it may hold, by name in `server/pages/schemas.ts`. */
  fileTypes: readonly string[];
  /** The keys its plugins' `when` conditions may test. */
  contextKeys: readonly string[];
  /** Whether it has members (papers), in `page_members`. */
  scope: boolean;
  /** How many `/`-separated segments its key may have. */
  maxDepth: number;
}

const slots = (kind: PageKind, extra: readonly string[] = []) => [
  ...GENERIC_SLOTS.map((slot) => `${kind}.${slot}`),
  ...extra.map((slot) => `${kind}.${slot}`),
];

const COMMON_CONTEXT = ['page.kind', 'signedIn', 'viewer.isOwner'] as const;

export const KINDS = {
  paper: {
    kind: 'paper',
    title: 'Paper',
    route: '/abs',
    repo: true,
    kindFile: '.potentialpaper/metadata.json',
    kindFileSchema: null,
    owners: { dir: OWNERS_DIR, title: 'the authors', noun: 'confirmed authors', claim: 'authors' },
    community: true,
    slots: slots('paper', ['title', 'submission', 'community', 'author']),
    fileTypes: [
      'section',
      'labeledLink',
      'authorPlugins',
      'link',
      'version',
      'thumbnail',
      'submission',
      'forms',
      'note',
    ],
    contextKeys: [...COMMON_CONTEXT, 'page.hasScores', 'page.hasSubmissions', 'page.hasSignals'],
    scope: false,
    maxDepth: 1,
  },
  venue: {
    kind: 'venue',
    title: 'Venue',
    route: '/v',
    repo: true,
    kindFile: 'venue.json',
    kindFileSchema: venueFileSchema,
    owners: { dir: OWNERS_DIR, title: 'the organisers', noun: 'confirmed organisers', claim: 'organisers' },
    community: true,
    slots: slots('venue'),
    fileTypes: ['section', 'labeledLink', 'venue'],
    contextKeys: [...COMMON_CONTEXT, 'page.hasScores', 'page.hasSubmissions', 'page.hasSignals'],
    scope: true,
    maxDepth: 4,
  },
  topic: {
    kind: 'topic',
    title: 'Topic',
    route: '/t',
    repo: true,
    kindFile: 'topic.json',
    kindFileSchema: topicFileSchema,
    owners: null,
    community: true,
    slots: slots('topic'),
    fileTypes: ['section', 'labeledLink', 'topic'],
    contextKeys: [...COMMON_CONTEXT, 'page.hasSignals'],
    scope: true,
    maxDepth: 1,
  },
  org: {
    kind: 'org',
    title: 'Organisation',
    route: '/o',
    repo: true,
    kindFile: 'org.json',
    kindFileSchema: orgFileSchema,
    owners: { dir: OWNERS_DIR, title: 'the members', noun: 'verified members', claim: 'domain' },
    community: true,
    slots: slots('org'),
    fileTypes: ['section', 'labeledLink', 'org'],
    contextKeys: [...COMMON_CONTEXT, 'page.hasScores', 'page.hasSignals'],
    scope: true,
    maxDepth: 3,
  },
  user: {
    kind: 'user',
    title: 'Person',
    route: '/u',
    repo: false,
    kindFile: null,
    kindFileSchema: null,
    owners: null,
    community: false,
    slots: slots('user'),
    fileTypes: [],
    contextKeys: [...COMMON_CONTEXT],
    scope: false,
    maxDepth: 1,
  },
} as const satisfies Record<PageKind, KindInfo>;

/** The kinds other than paper, whose addresses are made from their key. */
export const KEYED_KINDS = PAGE_KINDS.filter((kind) => kind !== 'paper') as Exclude<PageKind, 'paper'>[];
export type KeyedKind = Exclude<PageKind, 'paper'>;

/** The folders of a kind's sections, owners' first: `['owners', 'community']` on a paper. */
export function partsOf(kind: PageKind): string[] {
  const { owners, community } = KINDS[kind];
  return [...(owners ? [owners.dir] : []), ...(community ? ['community'] : [])];
}

/** Every folder any kind writes sections in, for checks that run before the kind is known (`prek.toml`). */
export const ALL_PARTS = [...new Set(PAGE_KINDS.flatMap(partsOf))];

/** Why this can't be a key of the kind, or `null`. */
export function keyProblem(kind: KeyedKind, key: string): string | null {
  if (kind === 'user') return HANDLE_PATTERN.test(key) ? null : 'is not a handle';
  const segments = key.split('/');
  if (segments.length > KINDS[kind].maxDepth) return `has more than ${KINDS[kind].maxDepth} parts`;
  for (const segment of segments) {
    if (!SLUG.test(segment) || segment.length > MAX_SEGMENT) {
      return 'is not lower-case slugs (letters, digits and dashes) separated by /';
    }
  }
  return null;
}

/** A page as its public identifier names it: a paper by one of its identifiers, any other kind by its key. */
/**
 * A page's address. A paper's is its short one, `/s/<n>`, when `shortId` is known (`pagePath`); its identifier still
 * names it, and the page tools are in front of the identifier's path (`identifierPath`).
 */
export type PageAddress = { kind: 'paper'; id: PaperId; shortId?: number } | { kind: KeyedKind; key: string };

/**
 * A public identifier (DESIGN.md §8), as a link's `to` holds it: `arxiv:1706.03762`, `doi:10.…`,
 * `openreview:…`, `venue:iclr/2027`, `topic:linear-attention`, `org:eth/inf`, `user:alice`. `null` if it isn't one.
 */
export function parseIdentifier(text: string): PageAddress | null {
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const scheme = text.slice(0, at);
  const rest = text.slice(at + 1);
  if ((PAPER_SCHEMES as readonly string[]).includes(scheme)) {
    const id = parsePaperId(scheme as PaperScheme, rest);
    return id ? { kind: 'paper', id } : null;
  }
  if (!isPageKind(scheme) || scheme === 'paper') return null;
  const key = scheme === 'user' ? rest.toLowerCase() : rest;
  return keyProblem(scheme, key) ? null : { kind: scheme, key };
}

/** The identifier in its normal form, as `page_links.target` keeps it. */
export function formatIdentifier(address: PageAddress): string {
  return address.kind === 'paper' ? `${address.id.scheme}:${address.id.value}` : `${address.kind}:${address.key}`;
}

/** A keyed page's address on the site: `/v/iclr/2027`. */
export function keyedPagePath(kind: KeyedKind, key: string): string {
  return `${KINDS[kind].route}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Any page's address on the site: a paper's short one where its `shortId` is known. */
export function pagePath(address: PageAddress): string {
  if (address.kind === 'paper' && address.shortId !== undefined) return shortPath(address.shortId);
  return identifierPath(address);
}

/** A page's path by its identifier (`/abs/1706.03762`, `/v/iclr/2027`), which the page tools go in front of. */
export function identifierPath(address: PageAddress): string {
  return address.kind === 'paper' ? paperPath(address.id) : keyedPagePath(address.kind, address.key);
}

/**
 * A page as the API and the web editor name it, a scheme and a value: a paper by an identifier (`arxiv`,
 * `1706.03762`), any other kind by its kind and key (`venue`, `iclr/2027`). Its identifier is `<scheme>:<value>`.
 */
export interface PageRef {
  scheme: string;
  value: string;
}

/** Every scheme a `PageRef` may have. */
export const PAGE_SCHEMES = [...PAPER_SCHEMES, ...(PAGE_KINDS.filter((kind) => kind !== 'paper') as KeyedKind[])];

export function pageRefOf(address: PageAddress): PageRef {
  return address.kind === 'paper'
    ? { scheme: address.id.scheme, value: address.id.value }
    : { scheme: address.kind, value: address.key };
}

/** The address a `PageRef` names, or `null` if it names none. */
export function addressOfRef({ scheme, value }: PageRef): PageAddress | null {
  return parseIdentifier(`${scheme}:${value}`);
}

/**
 * The address a path on the site names, by its first segment and the rest (`v`, `['iclr', '2027']`): what the page
 * tools (`/history/v/iclr/2027`) put after their own name. `null` if it names none.
 */
export function addressOfPath(prefix: string, segments: readonly string[]): PageAddress | null {
  let raw: string;
  try {
    raw = segments.map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  const scheme = PAPER_SCHEMES.find((s) => PATH_PREFIX[s] === `/${prefix}`);
  if (scheme) {
    const id = parsePaperId(scheme, raw);
    return id ? { kind: 'paper', id } : null;
  }
  const kind = KEYED_KINDS.find((k) => KINDS[k].route === `/${prefix}`);
  if (!kind) return null;
  const key = kind === 'user' ? raw.toLowerCase() : raw;
  return keyProblem(kind, key) ? null : { kind, key };
}

/** A paper page's address among its identifiers: the canonical one. */
export function paperAddress(ids: readonly PaperId[]): PageAddress | null {
  const id = canonicalPaperId(ids);
  return id ? { kind: 'paper', id } : null;
}

/**
 * The parents a keyed page has, as identifiers: by its address (an edition's series, a lab's institution) and by
 * its kind file (an org's `parents`). Roll-ups follow these (`page_ancestors`).
 */
export function parentsOf(kind: KeyedKind, key: string, kindFile: unknown): string[] {
  const out = new Set<string>();
  const at = key.lastIndexOf('/');
  if (at > 0 && (kind === 'venue' || kind === 'org')) out.add(`${kind}:${key.slice(0, at)}`);
  if (kind === 'org') {
    const parsed = orgFileSchema.safeParse(kindFile);
    for (const parent of parsed.success ? (parsed.data.parents ?? []) : []) out.add(`org:${parent}`);
  }
  out.delete(`${kind}:${key}`);
  return [...out];
}

/**
 * The names a scope answers to besides its own identifier: a venue's `sources`, so that a paper's submission to
 * `openreview:ICLR.cc/2027/Conference` makes it a member of the venue page that lists that source; an org's
 * `domains`, as `domain:ethz.ch`, so that a paper with a member's claim or an address at that domain (or under it) is
 * one of its papers (`server/page-members.ts`).
 */
export function sourcesOf(kind: KeyedKind, kindFile: unknown): string[] {
  if (kind === 'venue') {
    const parsed = venueFileSchema.safeParse(kindFile);
    return parsed.success ? (parsed.data.sources ?? []) : [];
  }
  if (kind === 'org') {
    const parsed = orgFileSchema.safeParse(kindFile);
    return parsed.success ? (parsed.data.domains ?? []).map(domainName) : [];
  }
  return [];
}

/** The name a domain goes by among a scope's names (`page_scope_names`): `domain:ethz.ch`. */
export function domainName(domain: string): string {
  return `domain:${domain}`;
}

/**
 * Whether `domain` is `under` or one of its subdomains: `inf.ethz.ch` is under `ethz.ch`, and so is `ethz.ch`; an
 * address matches an org by every domain it is under, as `server/institution-domains.ts` matches the allowlist.
 */
export function isUnderDomain(domain: string, under: string): boolean {
  return domain === under || domain.endsWith(`.${under}`);
}

/** The name a keyed page shows: its kind file's `name`, or else its key; a user page's handle. */
export function pageName(kind: KeyedKind, key: string, kindFile: unknown): string {
  // A person's page is named by its handle, whatever its files say (DESIGN.md §5.3).
  if (kind === 'user') return `@${key}`;
  if (kindFile && typeof kindFile === 'object' && 'name' in kindFile && typeof kindFile.name === 'string') {
    return kindFile.name;
  }
  return key;
}
