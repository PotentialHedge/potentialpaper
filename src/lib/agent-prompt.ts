/** Where an agent reads how to work here: `app/agent/start/route.ts`. */
export const AGENT_START_PATH = '/agent/start';

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
