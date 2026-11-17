// Private notes: the example of a plugin with its own backend (`handoffs/plugins.md` Phase 5). No build step.
//
// The frame asks the site for an identity token (`pp.identity.token()`, permission `identity`) and sends it to the
// plugin's backend, one of the manifest's `network` origins, the only ones its CSP lets it reach. The backend
// (`examples/plugins/notes-backend/`) checks the token against the site's keys and keeps the notes under the token's
// `sub`. It never sees the reader's session; the site never sees the notes.
/* global pp */

const $ = (id) => document.getElementById(id);
/** Where the backend runs while you develop: a plugin loaded from localhost is served with its dev server's CSP. */
const DEV_BACKEND = 'http://localhost:8787';

function backend(ctx) {
  if (ctx.settings.backend) return ctx.settings.backend.replace(/\/+$/, '');
  return ctx.plugin.dev ? DEV_BACKEND : 'https://notes.potentialpaper.example';
}

function say(text) {
  $('status').textContent = text;
}

async function call(ctx, method, body) {
  const url = `${backend(ctx)}/notes?page=${encodeURIComponent(ctx.page.identifier)}`;
  const res = await pp.identity.fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res.json();
}

pp.ready.then(async (ctx) => {
  if (!ctx.page) return;
  if (!ctx.viewer.signedIn) return say('Sign in to keep notes.');
  const note = $('note');
  try {
    const { text, updatedAt } = await call(ctx, 'GET');
    note.value = text;
    note.disabled = false;
    say(updatedAt ? `Saved ${new Date(updatedAt).toLocaleString()}.` : '');
  } catch (e) {
    return say(
      e.code === 'PermissionDenied' ? 'Approve this plugin on /settings/plugins to keep notes.' : `${e.message}`,
    );
  }
  let timer = null;
  note.addEventListener('input', () => {
    clearTimeout(timer);
    say('…');
    timer = setTimeout(async () => {
      try {
        await call(ctx, 'PUT', { text: note.value });
        say('Saved.');
      } catch (e) {
        say(`Not saved: ${e.message}`);
      }
    }, 600);
  });
});
