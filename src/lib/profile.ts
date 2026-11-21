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
