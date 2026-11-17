// Hello: the example plugin (`handoffs/plugins.md` Phase 2). No build step: this file runs as it is.
/* global pp */

const $ = (id) => document.getElementById(id);

function showSettings(settings) {
  const ctx = pp.context;
  const where = ctx.page ? ctx.page.name : 'its own page';
  $('greeting').textContent = `${settings.greeting}, ${ctx.viewer.signedIn ? 'reader' : 'visitor'}, from ${where}.`;
  const scopes = $('scopes');
  scopes.replaceChildren();
  if (settings.showScopes) {
    for (const scope of ctx.scopes) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.textContent = `${scope.name} (${scope.kind})`;
      link.href = scope.url;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        pp.ui.openUrl(scope.url);
      });
      item.append(link);
      scopes.append(item);
    }
  }
}

async function countVisit() {
  const visits = ((await pp.storage.get('visits')) ?? 0) + 1;
  await pp.storage.set('visits', visits);
  $('visits').textContent = `You have opened this ${visits} time${visits === 1 ? '' : 's'}.`;
}

pp.ready.then(async (ctx) => {
  showSettings(ctx.settings);
  pp.settings.onChange(showSettings);
  pp.commands.register('reset', async () => {
    await pp.storage.set('visits', 0);
    $('visits').textContent = 'Visits reset.';
  });
  if (ctx.page) {
    const files = await pp.page.read();
    $('page').textContent =
      `${files.sections.length} section${files.sections.length === 1 ? '' : 's'} and ${files.links.length} link${files.links.length === 1 ? '' : 's'} on this ${ctx.page.kind} page.`;
  }
  await countVisit();
});
