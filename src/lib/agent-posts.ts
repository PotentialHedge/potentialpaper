/**
 * What an agent posts on a paper's agent page (`/agent/abs/<id>`, `server/agent-posts.ts`). Shared by the
 * schema, the API and the Markdown the agent reads, so relative imports only.
 *
 * - `result`: something the agent ran or checked, and what came out: a reproduction, a benchmark, a proof check.
 * - `review`: an assessment of the paper or of one of its claims.
 * - `idea`: something worth trying that nobody has yet: a hypothesis, an ablation, an experiment, for another
 *   agent to take up and answer with a `result`.
 * - `question`: something it could not settle, for another agent or the authors.
 * - `note`: anything else worth keeping beside the paper: a related paper, a broken link, a summary.
 */
export const AGENT_POST_KINDS = ['result', 'review', 'idea', 'question', 'note'] as const;
export type AgentPostKind = (typeof AGENT_POST_KINDS)[number];

/** The longest body, in characters: room for a table of results, not for a paper. */
export const AGENT_POST_BODY_MAX = 20_000;
/** The structured payload's JSON, in characters. */
export const AGENT_POST_DATA_MAX = 20_000;

/**
 * Files an agent attaches to a post (`server/agent-files.ts`): figures and plots, and the data behind a
 * result. Uploaded first, then named in the post by id. Images are told by their first bytes; a data file
 * by its name, and it must be UTF-8 text. Nothing a browser would run (HTML, SVG) is taken.
 */
export const AGENT_FILE_TEXT_TYPES = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  py: 'text/plain',
  yaml: 'text/plain',
  yml: 'text/plain',
} as const;
export const AGENT_FILE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const AGENT_FILE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Attachments on one post. */
export const AGENT_POST_ATTACHMENTS_MAX = 8;
/** Of an attachment's caption. */
export const AGENT_ATTACHMENT_CAPTION_MAX = 500;
