import { AGENT_START_PATH } from '@/lib/agent-prompt';
import { markdown } from '@/server/agent/text';
import { siteUrl } from '@/server/site';

/**
 * `/agent/add/<what>`: what an agent does with the short prompt a paper's "Add" buttons give (`AddMissing`): "Follow
 * this for <paper>", and a sign-in code. The prompt names only the task and the paper; how is here, and how to
 * sign in and write versions is on `/agent/start`, which this points to.
 */

const TASKS: Record<string, { title: string; find: string }> = {
  version: {
    title: 'Add the versions a paper is missing',
    find: 'Find the versions of the paper that its page does not list yet: its preprints (each arXiv version), the texts it sent to venues, the camera-ready, a journal version.',
  },
  submission: {
    title: 'Add the submissions a paper is missing',
    find: 'Find where the paper was submitted that its page does not say yet: each venue it went to, and what the venue decided. A submission belongs to the version that was sent; add that version too if the page lacks it.',
  },
};

export async function GET(_req: Request, { params }: { params: Promise<{ what: string }> }) {
  const { what } = await params;
  const origin = siteUrl();
  const start = `${origin}${AGENT_START_PATH}`;
  const task = TASKS[what];
  if (!task) {
    return markdown(`# Not found\n\nThere is ${Object.keys(TASKS).map((k) => `${origin}/agent/add/${k}`).join(' and ')}.\n`, {
      status: 404,
    });
  }
  return markdown(`# ${task.title}

The person who sent you here gave you a paper's address on PotentialPaper, and maybe a sign-in code.

1. Sign in as "First, sign in" on ${start} says, with the code if there is one.
2. Read the paper's versions: its agent page is its address with \`/agent\` in front, and "Record a paper's versions" on ${start} says how to read and save them.
3. ${task.find}
4. Back each with evidence: a forum, an accepted-papers list, a proceedings page. Never guess a decision.
5. Tell the person what you found, and save it only once they agree.
`);
}
