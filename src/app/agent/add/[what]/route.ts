import { AGENT_SETUP_PATH, AGENT_START_PATH } from '@/lib/agent-prompt';
import { markdown } from '@/server/agent/text';
import { siteUrl } from '@/server/site';

/**
 * `/agent/add/<what>`: what an agent does with the short prompt a paper's "Add" buttons give (`AddMissing`): "Follow
 * this for <paper>", and a sign-in code. The prompt names only the task and the paper; how is here, and how to
 * sign in, use git and write versions is on `/agent/setup` and `/agent/start`, which this points to.
 */

interface Links {
  origin: string;
  start: string;
  setup: string;
}

const TASKS: Record<string, { title: string; steps: (l: Links) => string[] }> = {
  version: {
    title: 'Add the versions a paper is missing',
    steps: ({ setup, start }) => [
      `Sign in as step 1 of ${setup} says, with the code if there is one.`,
      `Read the paper's versions: its agent page is its address with \`/agent\` in front, and "Record a paper's versions" on ${start} says how to read and save them.`,
      'Find the versions of the paper that its page does not list yet: its preprints (each arXiv version), the texts it sent to venues, the camera-ready, a journal version.',
      'Back each with evidence: a forum, an accepted-papers list, a proceedings page. Never guess a decision.',
      'Tell the person what you found, and save it only once they agree.',
    ],
  },
  submission: {
    title: 'Add the submissions a paper is missing',
    steps: ({ setup, start }) => [
      `Sign in as step 1 of ${setup} says, with the code if there is one.`,
      `Read the paper's versions and submissions: its agent page is its address with \`/agent\` in front, and "Record a paper's versions" on ${start} says how to read and save them.`,
      'Find where the paper was submitted that its page does not say yet: each venue it went to, and what the venue decided. A submission belongs to the version that was sent; add that version too if the page lacks it.',
      'Back each with evidence: a forum, an accepted-papers list, a proceedings page. Never guess a decision.',
      'Tell the person what you found, and save it only once they agree.',
    ],
  },
  demo: {
    title: 'Build an interactive demo of a paper',
    steps: ({ origin, setup }) => [
      `Set up as ${setup} says, for this paper's page: sign in (with the code if there is one), then git and a clone of the page (its step 3 says how the paper's path gives its clone address).`,
      `Read the paper: its agent page is its address with \`/agent\` in front (\`${origin}/agent/abs/1706.03762\`), with its PDF and what its page already has. Look in \`demos/\` and the \`community/\` sections for a demo it already has, and build a different one.`,
      'Pick one idea of the paper that is easier to understand by playing with it: an equation with a parameter to drag, an algorithm to step through, a figure to explore. Say in a line or two what you plan, and ask the person before you build it.',
      "Build it as a folder `demos/<name>/` in the clone (`<name>` a lower-case slug), with an `index.html`. Plain HTML, CSS and JavaScript that run as they are, with no build step; each file at most 1 MB. Make it work at any width, with the controls labelled and a sentence saying what to try.\n\n   Make it look roughly like the page it sits in, loosely, not exactly: a light, off-white background (`#fefdfb`) with near-black text (`#1d1d1d`); a serif (Georgia) for prose and a system sans-serif for controls and labels; one accent, the site's dark red (`#b31b1b`), for what matters most, with greys (`#777`, `#ddd` for thin rules and borders) for the rest; square corners, no shadows or gradients, and plenty of space. Charts plain, as in a paper. Where the idea needs more colours (several series, a heat map), use a few muted ones.",
      'Show it on the page: add a community section, `community/NN-<name>.md`, that starts with a `#` heading, says in a sentence what the demo shows, and embeds it:\n\n   ````\n   ```demo demos/<name>\n   Its title\n   What it shows, in a line.\n   ```\n   ````',
      "Open `demos/<name>/index.html` in a browser to check it works. If a person is working with you, give them its path and let them open and try it themselves, and change what they ask; commit and push only once they agree. Then give them the paper's address, where the demo now shows.",
    ],
  },
};

export async function GET(_req: Request, { params }: { params: Promise<{ what: string }> }) {
  const { what } = await params;
  const origin = siteUrl();
  const links = { origin, start: `${origin}${AGENT_START_PATH}`, setup: `${origin}${AGENT_SETUP_PATH}` };
  const task = TASKS[what];
  if (!task) {
    const all = Object.keys(TASKS).map((k) => `${origin}/agent/add/${k}`);
    return markdown(`# Not found\n\nThere is ${all.slice(0, -1).join(', ')} and ${all.at(-1)}.\n`, { status: 404 });
  }
  const steps = task
    .steps(links)
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n');
  return markdown(
    `# ${task.title}

The person who sent you here gave you a paper's address on PotentialPaper (a path like \`/abs/1706.03762\`: it is on ${origin}), and maybe a sign-in code.

${steps}
`,
  );
}
