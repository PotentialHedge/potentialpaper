import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as schemas from '@/app/schemas/[file]/route';
import { saveSiteSettings } from '@/server/settings';
import { api, closePool, ORIGIN, resetDatabase, signUp } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

describe('settings.json', () => {
  it('starts empty, with every setting at its default', async () => {
    const cookie = await signUp('reader@ethz.ch');
    const res = await api('GET', '/me/settings', { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: '{}\n', problems: [], updatedAt: null });
    expect(res.body.values['paper.panels.hidden']).toEqual([]);
  });

  it('keeps the text as written, comments and all, and resolves it over the site layer', async () => {
    await saveSiteSettings('{ "paper.panels.hidden": ["discussion"], "paper.panels.order": ["submissions"] }');
    const cookie = await signUp('reader@ethz.ch');
    const text =
      '{\n  // Abstract last.\n  "paper.panels.order": ["sections", "abstract"],\n  "later/plugin.x": 1,\n}\n';
    const put = await api('PUT', '/me/settings', { cookie, text });
    expect(put.status).toBe(200);
    expect(put.body.text).toBe(text);
    expect(put.body.values).toMatchObject({
      'paper.panels.hidden': ['discussion'],
      'paper.panels.order': ['sections', 'abstract'],
    });
    expect(put.body.problems).toEqual([
      expect.objectContaining({ severity: 'warning', key: 'later/plugin.x', line: 4 }),
    ]);
    const got = await api('GET', '/me/settings', { cookie });
    expect(got.body.text).toBe(text);
    expect(got.body.updatedAt).toEqual(expect.any(String));

    // Signed out: the defaults and the site layer.
    const site = await api('GET', '/settings');
    expect(site.status).toBe(200);
    expect(site.body.values).toMatchObject({
      'paper.panels.hidden': ['discussion'],
      'paper.panels.order': ['submissions'],
    });
  });

  it('refuses a file with errors, naming every one on a line of its own, and keeps the old one', async () => {
    const cookie = await signUp('reader@ethz.ch');
    await api('PUT', '/me/settings', { cookie, text: '{ "paper.panels.hidden": ["abstract"] }' });
    const res = await api('PUT', '/me/settings', {
      cookie,
      text: '{\n  "paper.panels.hidden": ["nope"],\n  "paper.panels.order": 3\n}',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
    const lines = res.body.error.message.split('\n');
    expect(lines[0]).toBe('settings.json has 2 problems:');
    expect(lines[1]).toMatch(/^paper\.panels\.hidden: /);
    expect(lines[2]).toMatch(/^paper\.panels\.order: /);
    expect(res.body.error.details.problems).toHaveLength(2);

    const syntax = await api('PUT', '/me/settings', { cookie, text: '{ "a": 1 "b": 2 }' });
    expect(syntax.status).toBe(422);
    expect(syntax.body.error.message).toMatch(/line 1: /);

    const kept = await api('GET', '/me/settings', { cookie });
    expect(kept.body.values['paper.panels.hidden']).toEqual(['abstract']);
  });

  it('changes some keys with PATCH, keeping the rest of the file, and null puts one back to its default', async () => {
    const cookie = await signUp('reader@ethz.ch');
    const text = '{\n  // Mine.\n  "paper.panels.hidden": ["abstract"]\n}\n';
    await api('PUT', '/me/settings', { cookie, text });
    const res = await api('PATCH', '/me/settings', {
      cookie,
      body: { 'navbar.order': ['changes', 'settings'], 'navbar.hidden': ['papers'] },
    });
    expect(res.status).toBe(200);
    expect(res.body.text).toContain('// Mine.');
    expect(res.body.values).toMatchObject({
      'paper.panels.hidden': ['abstract'],
      'navbar.order': ['changes', 'settings'],
      'navbar.hidden': ['papers'],
    });
    const reset = await api('PATCH', '/me/settings', { cookie, body: { 'navbar.hidden': null } });
    expect(reset.body.values['navbar.hidden']).toEqual(['changes']);
    expect(reset.body.text).not.toContain('navbar.hidden');

    const bad = await api('PATCH', '/me/settings', { cookie, body: { 'navbar.hidden': ['settings'] } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/^navbar\.hidden: /m);
    expect((await api('PATCH', '/me/settings', { cookie, body: [1] })).status).toBe(422);
  });

  it('needs an account, and a token with the write scope to change it', async () => {
    expect((await api('GET', '/me/settings')).status).toBe(401);
    const cookie = await signUp('agent-owner@ethz.ch');
    const minted = await api('POST', '/me/tokens', { cookie, body: { name: 'reader', scopes: ['read'] } });
    expect(minted.status).toBe(201);
    const token = minted.body.token as string;
    expect((await api('GET', '/me/settings', { token })).status).toBe(200);
    expect((await api('PUT', '/me/settings', { token, text: '{}' })).status).toBe(403);
  });

  it('serves the JSON Schema of the settings at /schemas/settings.json', async () => {
    const res = await schemas.GET(new Request(new URL('/schemas/settings.json', ORIGIN)), {
      params: Promise.resolve({ file: 'settings.json' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/private/);
    const schema = await res.json();
    expect(schema.$id).toBe(`${ORIGIN}/schemas/settings.json`);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['paper.panels.hidden', 'paper.panels.order']),
    );
  });
});
