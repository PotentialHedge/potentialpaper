// Reading list: the example of notes on rows (`contributes.rows`). No build step: this file runs as it is.
// Each paper's entry is kept in the reader's plugin storage as `paper:<identifier>`: { toRead, note }.
/* global pp */

const key = (paper) => `paper:${paper}`;
const NOTE_LENGTH = 40;

/** What a paper's row shows: the reader's line, else "to read", else nothing (the venue). */
function rowNote(entry) {
  if (entry?.note) {
    const text = entry.note.length > NOTE_LENGTH ? `${entry.note.slice(0, NOTE_LENGTH - 1)}…` : entry.note;
    return {
      text,
      title: entry.toRead ? `To read. ${entry.note}` : entry.note,
      tone: entry.toRead ? 'accent' : 'muted',
    };
  }
  return entry?.toRead ? { text: 'to read', title: 'On your reading list', tone: 'accent' } : null;
}

async function save(paper, entry) {
  const kept = entry && (entry.toRead || entry.note) ? entry : null;
  await pp.storage.set(key(paper), kept);
  await pp.rows.set({ [paper]: rowNote(kept) });
}

/** The hidden frame of the list: note every listed paper, and handle the commands that need no form. */
async function list() {
  const show = async (papers) => {
    const all = await pp.storage.get();
    await pp.rows.set(Object.fromEntries(papers.map((paper) => [paper, rowNote(all[key(paper)])])));
  };
  await show(pp.rows.papers);
  pp.rows.onChange(show);
  pp.commands.register('toggle', async ({ paper }) => {
    const entry = (await pp.storage.get(key(paper))) ?? {};
    await save(paper, { ...entry, toRead: !entry.toRead });
  });
}

/** A row's popover: a line on that paper. */
async function popover(paper) {
  const form = document.getElementById('form');
  const text = document.getElementById('text');
  const entry = (await pp.storage.get(key(paper))) ?? {};
  text.value = entry.note ?? '';
  form.hidden = false;
  text.focus();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await save(paper, { ...entry, note: text.value.trim() });
    await pp.ui.close();
  });
  document.getElementById('clear').addEventListener('click', async () => {
    await save(paper, { ...entry, note: '' });
    await pp.ui.close();
  });
}

pp.ready.then((ctx) => {
  if (ctx.surface.type === 'rows') return list();
  if (ctx.surface.type === 'popover') return popover(ctx.surface.paper);
});
