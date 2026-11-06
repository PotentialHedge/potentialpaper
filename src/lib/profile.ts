/** The rules for a public profile, shared by the forms and the API. */

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
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
  'potentialpaper',
  'root',
  'staff',
  'support',
  'system',
  'verified',
]);

/** The sentence to show for a bad handle, or `null` for a good one. */
export function handleProblem(handle: string): string | null {
  if (!HANDLE_PATTERN.test(handle)) {
    return 'Use 3 to 30 lower-case letters, digits or hyphens, starting and ending with a letter or digit.';
  }
  if (RESERVED.has(handle) || PLACEHOLDER_PATTERN.test(handle)) return 'That handle is reserved.';
  return null;
}

export const REAL_NAME_MAX = 120;
