// Keeping a signal set current from the events feed: a publisher's backend in one file. Node 18+, no dependencies.
//
//   SITE=https://papers.potentialhedge.com SET=<owner>/<name> PP_TOKEN=<publisher's API key> node follow.mjs
//
// It reads every commit to every paper, oldest first (`GET /api/v1/events`), and recomputes its signal for each paper
// that is new, merged into, or whose metadata changed, writing the values in batches. The cursor is kept in
// CURSOR_FILE after each batch is written, so a restart picks up exactly where it stopped: the feed never skips an
// event. The first run starts at the present (`after=now`); to fill the set for papers from before, start without a
// cursor file and set FROM_START=1.
//
// The signal here is a stand-in: `title.words`, a number signal (declare it in your manifest's `contributes.signals`),
// from the paper's title. Put your model where `compute` is.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SITE = (process.env.SITE ?? 'http://localhost:3000').replace(/\/$/, '');
const SET = process.env.SET ?? 'you/your-set';
const CURSOR_FILE = process.env.CURSOR_FILE ?? '.events-cursor';
/** Files whose change means the value is out of date. */
const INPUTS = ['metadata.json'];

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function call(method, path, body) {
  const res = await fetch(`${SITE}/api/v1${path}`, {
    method,
    headers: {
      ...(process.env.PP_TOKEN ? { authorization: `Bearer ${process.env.PP_TOKEN}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

/** The value for one paper. */
function compute(event) {
  return event.page.name.split(/\s+/).filter(Boolean).length;
}

/** Whether an event changes what the signal is computed from. */
const matters = (e) => e.created || e.merged || e.paths.some((p) => INPUTS.includes(p));

async function main() {
  let cursor = existsSync(CURSOR_FILE) ? readFileSync(CURSOR_FILE, 'utf8').trim() : process.env.FROM_START ? '' : 'now';
  for (;;) {
    const query = new URLSearchParams({
      kind: 'paper',
      limit: '500',
      wait: '25',
      ...(cursor ? { after: cursor } : {}),
    });
    let page;
    try {
      page = await call('GET', `/events?${query}`);
    } catch (e) {
      log('read failed, trying again in 10 s:', e.message);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    // One value per paper, the latest: a batch can hold several commits to one paper.
    const values = new Map();
    for (const event of page.events.filter(matters)) {
      values.set(event.page.identifier, { paper: event.page.identifier, signal: 'title.words', value: compute(event) });
    }
    if (values.size > 0) {
      await call('PUT', `/signal-sets/${SET}/values`, { values: [...values.values()] });
      log(`wrote ${values.size} values`);
    }
    // Only once the values are written: a crash before this reads the same events again.
    cursor = page.next;
    writeFileSync(CURSOR_FILE, `${cursor}\n`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
