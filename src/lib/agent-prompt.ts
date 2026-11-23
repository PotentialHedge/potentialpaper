/** Where an agent reads how to work here: `app/agent/start/route.ts`. */
export const AGENT_START_PATH = '/agent/start';

/** The one setup checklist for agents (sign-in, git, credentials, SSH key): `app/agent/setup/route.ts`. */
export const AGENT_SETUP_PATH = '/agent/setup';

/** The name of the token an agent signs in for, so the person can find and revoke it on `/profile`. */
export const AGENT_TOKEN_NAME = 'ai-agent';

/** Where an agent reads how to build a plugin: `app/plugins.md/route.ts`. */
export const PLUGINS_GUIDE_PATH = '/plugins.md';

/**
 * Every prompt the site gives a reader to paste into their AI agent has this one shape: "Follow <origin><page>[ for
 * <target>]." and "My sign-in code: <code>" when there is one. The page says everything else. The site's address is
 * written once: `target` is a path on it, a page's short one where it has one (`/s/42`, `/v/iclr/2027`), read against
 * the page's origin.
 */
export function followPrompt(origin: string, page: string, { target, code }: { target?: string; code?: string } = {}) {
  const follow = `Follow ${origin}${page}${target ? ` for ${target}` : ''}.`;
  return code ? `${follow} My sign-in code: ${code}` : follow;
}

/** A path on the site, from an address on it: the prompt names the origin once. */
function onSite(origin: string, url: string): string {
  return url.startsWith(origin) ? url.slice(origin.length) || '/' : url;
}

/**
 * The prompt `OnboardAgent` copies: a pointer to `/agent/start`, which says everything else (what to ask the person,
 * how to post; signing in is on `/agent/setup`), and, for a signed-in person, a one-time code (`POST /me/agent-code`,
 * an hour) the agent trades for a token. No email: the code alone names the person. Signed out, the agent asks for
 * the person's email and gets a code mailed.
 */
export function agentPrompt(origin: string, code?: string): string {
  return followPrompt(origin, AGENT_START_PATH, { code });
}

/** The prompt a paper's "Add" buttons give (`AddMissing`): the task's page, `/agent/add/<what>`, for the paper's path. */
export function addPrompt(
  origin: string,
  what: 'version' | 'submission' | 'demo' | 'picture',
  paperPath: string,
  code?: string,
): string {
  return followPrompt(origin, `/agent/add/${what}`, { target: onSite(origin, paperPath), code });
}

/** The prompt the Edit dialog's agent option gives: `/agent/setup`, the one setup checklist, for the page's path. */
export function setupPrompt(origin: string, pagePath: string, code?: string): string {
  return followPrompt(origin, AGENT_SETUP_PATH, { target: onSite(origin, pagePath), code });
}

/** The prompt to build a plugin with an agent (Settings → Plugins, and the top of `/plugins.md`). */
export function pluginPrompt(origin: string): string {
  return followPrompt(origin, PLUGINS_GUIDE_PATH, { target: 'a new PotentialPaper plugin' });
}
