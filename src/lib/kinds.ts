import { z } from 'zod';
import { canonicalPaperId, PAPER_SCHEMES, paperPath, parsePaperId, type PaperId, type PaperScheme } from './paper-ids';
import { HANDLE_PATTERN } from './profile';
import { USER_SHOW, USER_SHOW_ITEMS, type UserShowItem } from './user-pages';

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
 * - **its parts**: the folders of sections people write, the owners' (`author/`, `organizers/`, `members/`,
 *   `about/`) and `community/`, each also holding that part's `links.jsonl`. Who may write which is in `rules.ts`;
 * - **its slots**: every kind has `<kind>.main`, `<kind>.aside` and `<kind>.tabs`, and a kind may add its own;
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

/** A `topic.json`: a research idea at the size of a Wikipedia article, not a field. */
export const topicFileSchema = z
  .strictObject({
    name: shortText(120).meta({ description: 'The topic\'s name: "Linear attention".' }),
    aliases: z
      .array(shortText(120))
      .max(20)
      .optional()
      .meta({ description: 'Other names it goes by, which search and suggestions match too.' }),
    broader: slugList('Broader topics, by slug: "efficient-transformers". Optional and loose, a DAG.'),
  })
  .meta({ title: 'Topic', description: "A topic page's topic.json: its name, aliases and broader topics." });

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

/**
 * A `profile.json`: what the person chose to show (`lib/user-pages.ts`), one switch per item, as their
 * `user.show.*` settings say. The site writes it from those settings (`server/user-pages.ts`); it holds the choices,
 * never the values (a real name in a commit would stay in the history after it is turned off). A missing item reads as
 * its §5.3-safe default.
 */
export const profileFileSchema = z
  .strictObject({
    show: z
      .strictObject(
        Object.fromEntries(
          USER_SHOW_ITEMS.map((item) => [item, z.boolean().optional().meta({ description: USER_SHOW[item].title })]),
        ) as Record<UserShowItem, z.ZodOptional<z.ZodBoolean>>,
      )
      .optional()
      .meta({ description: 'What the page shows beyond the handle, about/ and links.' }),
  })
  .meta({
    title: 'Profile',
    description:
      "A user page's profile.json: what the account chose to show, as its user.show.* settings say. Written by the site.",
  });

export type VenueFile = z.output<typeof venueFileSchema>;
export type TopicFile = z.output<typeof topicFileSchema>;
export type OrgFile = z.output<typeof orgFileSchema>;

/** The generic slots every kind has; a kind may add more (a paper's title and body). */
export const GENERIC_SLOTS = ['main', 'aside', 'tabs'] as const;
export type GenericSlot = (typeof GENERIC_SLOTS)[number];

export interface KindInfo {
  kind: PageKind;
  /** "Venue". */
  title: string;
  /** Where its pages are on the site: `/v`. A paper's are by identifier, `/abs`, `/doi`, `/openreview`. */
  route: string;
  /** The kind file, from the repo's root. */
  kindFile: string;
  /** Its schema; `null` for a paper's, which is the system's snapshot. */
  kindFileSchema: z.ZodType | null;
  /** The owners' part, if the kind has owners, and what the page calls it. */
  owners: { dir: string; title: string } | null;
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

export const KINDS: Record<PageKind, KindInfo> = {
  paper: {
    kind: 'paper',
    title: 'Paper',
    route: '/abs',
    kindFile: '.potentialpaper/metadata.json',
    kindFileSchema: null,
    owners: { dir: 'author', title: 'Author section' },
    community: true,
    slots: slots('paper', ['title', 'body', 'submission', 'community']),
    fileTypes: ['section', 'labeledLink', 'link', 'version', 'thumbnail', 'pdf', 'submission', 'forms', 'note'],
    contextKeys: [...COMMON_CONTEXT, 'page.hasScores', 'page.hasSubmissions', 'page.hasSignals'],
    scope: false,
    maxDepth: 1,
  },
  venue: {
    kind: 'venue',
    title: 'Venue',
    route: '/v',
    kindFile: 'venue.json',
    kindFileSchema: venueFileSchema,
    owners: { dir: 'organizers', title: 'Organisers' },
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
    kindFile: 'org.json',
    kindFileSchema: orgFileSchema,
    owners: { dir: 'members', title: 'Members' },
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
    kindFile: 'profile.json',
    kindFileSchema: profileFileSchema,
    owners: { dir: 'about', title: 'About' },
    community: false,
    slots: slots('user'),
    fileTypes: ['section', 'labeledLink', 'profile'],
    contextKeys: [...COMMON_CONTEXT],
    scope: false,
    maxDepth: 1,
  },
};

/** The kinds other than paper, whose addresses are made from their key. */
export const KEYED_KINDS = PAGE_KINDS.filter((kind) => kind !== 'paper') as Exclude<PageKind, 'paper'>[];
export type KeyedKind = Exclude<PageKind, 'paper'>;

/** The folders of a kind's sections, owners' first: `['author', 'community']` on a paper. */
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
export type PageAddress = { kind: 'paper'; id: PaperId } | { kind: KeyedKind; key: string };

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

/** Any page's address on the site. */
export function pagePath(address: PageAddress): string {
  return address.kind === 'paper' ? paperPath(address.id) : keyedPagePath(address.kind, address.key);
}

/** A paper page's address among its identifiers: the canonical one. */
export function paperAddress(ids: readonly PaperId[]): PageAddress | null {
  const id = canonicalPaperId(ids);
  return id ? { kind: 'paper', id } : null;
}

/**
 * The parents a keyed page has, as identifiers: by its address (an edition's series, a lab's institution) and by
 * its kind file (a topic's `broader`, an org's `parents`). Roll-ups follow these (`page_ancestors`).
 */
export function parentsOf(kind: KeyedKind, key: string, kindFile: unknown): string[] {
  const out = new Set<string>();
  const at = key.lastIndexOf('/');
  if (at > 0 && (kind === 'venue' || kind === 'org')) out.add(`${kind}:${key.slice(0, at)}`);
  if (kind === 'topic') {
    const parsed = topicFileSchema.safeParse(kindFile);
    for (const slug of parsed.success ? (parsed.data.broader ?? []) : []) out.add(`topic:${slug}`);
  }
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
