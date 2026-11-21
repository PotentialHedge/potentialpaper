/** The rules for a public profile, shared by the forms and the API. */

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
/** What follows a bot's handle wherever it is shown, as `@openreview[bot]`, so nobody mistakes it for a person. */
export const BOT_SUFFIX = '[bot]';

/** A handle as it is shown: a bot's carries `[bot]` at the end. The stored handle never does. */
export function shownHandle(handle: string, bot: boolean): string {
  return bot ? `${handle}${BOT_SUFFIX}` : handle;
}

/** Assigned until someone chooses a handle, so nobody can choose one that looks like it. */
const PLACEHOLDER_PATTERN = /^user-[a-z0-9]{6}$/;

/** Names that would read as the site speaking, or as something other than a person. */
const RESERVED = new Set([
  'admin',
  'administrator',
  'anonymous',
  'author',
  'bot',
  'editor',
  'mod',
  'moderator',
  'openreview',
  'potentialpaper',
  'root',
  'staff',
  'support',
  'system',
  'verified',
]);

/**
 * What a handle field keeps of what was typed: lower case, and only the ASCII letters, digits and
 * hyphens a handle may hold, so emoji, accents and spaces never reach it.
 */
export function cleanHandleInput(typed: string): string {
  return typed.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/** The sentence to show for a bad handle, or `null` for a good one. */
export function handleProblem(handle: string): string | null {
  if (!HANDLE_PATTERN.test(handle)) {
    return 'Use 3 to 30 lower-case letters, digits or hyphens, starting and ending with a letter or digit.';
  }
  if (RESERVED.has(handle) || PLACEHOLDER_PATTERN.test(handle)) return 'That handle is reserved.';
  return null;
}

export const REAL_NAME_MAX = 120;
/** The longest bio: a few lines, as an abstract is a paragraph. */
export const BIO_MAX = 600;

/** The links a person's page shows under their name, each optional. */
export const PROFILE_LINKS = ['homepage', 'orcid', 'scholar'] as const;
export type ProfileLink = (typeof PROFILE_LINKS)[number];
export type ProfileLinks = Record<ProfileLink, string | null>;

export const PROFILE_LINK_INFO: Record<ProfileLink, { label: string; placeholder: string }> = {
  homepage: { label: 'Homepage', placeholder: 'https://…' },
  orcid: { label: 'ORCID', placeholder: '0000-0002-1825-0097' },
  scholar: { label: 'Google Scholar', placeholder: 'https://scholar.google.com/citations?user=…' },
};

const ORCID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const LINK_MAX = 300;

/**
 * What a link field keeps: `null` for a blank one, a homepage as an `https` address, an ORCID iD on its own (from the
 * iD or its orcid.org address), a Scholar profile as `https://scholar.google.com/citations?user=<id>`. Or a sentence
 * saying what is wrong.
 */
export function cleanProfileLink(
  link: ProfileLink,
  typed: string | null,
): { value: string | null } | { problem: string } {
  const text = typed?.trim() ?? '';
  if (!text) return { value: null };
  if (link === 'orcid') {
    const id = text.replace(/^(https?:\/\/)?(www\.)?orcid\.org\//i, '').toUpperCase();
    return ORCID.test(id) ? { value: id } : { problem: 'An ORCID iD looks like 0000-0002-1825-0097.' };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: `Give your ${PROFILE_LINK_INFO[link].label.toLowerCase()} as an address starting https://.` };
  }
  if (url.protocol !== 'https:' || text.length > LINK_MAX) {
    return { problem: `Give your ${PROFILE_LINK_INFO[link].label.toLowerCase()} as an https:// address.` };
  }
  if (link === 'scholar') {
    const user = url.searchParams.get('user');
    if (!/^scholar\.google\.[a-z.]+$/.test(url.hostname) || !user || !/^[\w-]{6,20}$/.test(user)) {
      return { problem: 'Give your Google Scholar profile’s address, with ?user= in it.' };
    }
    return { value: `https://scholar.google.com/citations?user=${user}` };
  }
  return { value: url.toString() };
}

/** Where a kept link goes. */
export function profileLinkHref(link: ProfileLink, value: string): string {
  return link === 'orcid' ? `https://orcid.org/${value}` : value;
}
