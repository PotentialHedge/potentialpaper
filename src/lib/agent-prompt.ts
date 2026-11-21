/** Where an agent reads how to work here: `app/agent/start/route.ts`. */
export const AGENT_START_PATH = '/agent/start';

/** The one setup checklist for agents (sign-in, git, credentials, SSH key): `app/agent/setup/route.ts`. */
export const AGENT_SETUP_PATH = '/agent/setup';

/** The name of the token an agent signs in for, so the person can find and revoke it on `/profile`. */
export const AGENT_TOKEN_NAME = 'ai-agent';

/**
 * The prompt `OnboardAgent` copies: a pointer to `/agent/start`, which says everything else (how to sign
 * in, what to ask the person, how to post), and, for a signed-in person, a one-time code
 * (`POST /me/agent-code`, an hour) the agent trades for a token. No email: the code alone names the person.
 * Signed out, `/agent/start` has the agent ask for the person's email and get a code mailed.
 */
export function agentPrompt(origin: string, code?: string): string {
  const read = `Read ${origin}${AGENT_START_PATH} and follow it to work with me on PotentialPaper.`;
  return code ? `${read} My sign-in code: ${code}` : read;
}

/**
 * The prompt a paper's "Add" buttons give (`AddMissing`): a pointer to the task's page, `/agent/add/<what>`, which
 * says how, the paper, and the sign-in code when there is one.
 */
export function addPrompt(origin: string, what: 'version' | 'submission', paperUrl: string, code?: string): string {
  const follow = `Follow ${origin}/agent/add/${what} for ${paperUrl}`;
  return code ? `${follow}. My sign-in code: ${code}` : `${follow}.`;
}

/**
 * The prompt the Edit dialog's "Agent" option gives, in `addPrompt`'s style: a pointer to `/agent/setup`, which says
 * everything (check and set up sign-in, git, credentials, an SSH key), the page's clone address, and the sign-in
 * code when there is one.
 */
export function setupPrompt(origin: string, cloneUrl: string, code?: string): string {
  const follow = `Follow ${origin}${AGENT_SETUP_PATH} for ${cloneUrl}`;
  return code ? `${follow}. My sign-in code: ${code}` : `${follow}.`;
}
