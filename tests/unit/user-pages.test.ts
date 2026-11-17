import { describe, expect, it } from 'vitest';
import { parseLabeledLinks } from '@/lib/labeled-links';
import { checkSettings, CORE_SETTINGS, parseSettings, resolveSettings, settingsJsonSchema } from '@/lib/settings';
import { DEFAULT_SHOWN, profileFileText, shownFromSettings, USER_SHOW_ITEMS, userShowKey } from '@/lib/user-pages';
import { profileFileSchema } from '@/lib/kinds';
import { commentExcerpt } from '@/server/user-pages';

describe('what a user page shows', () => {
  it('defaults to nothing that ties the handle to a name or an author identity (DESIGN.md §5.3)', () => {
    expect(DEFAULT_SHOWN).toEqual({
      realName: false,
      institution: false,
      claimedPapers: false,
      activity: true,
      comments: true,
    });
    const values = resolveSettings({});
    for (const item of USER_SHOW_ITEMS) expect(values[userShowKey(item)]).toBe(DEFAULT_SHOWN[item]);
  });

  it("is each account's own choice: the site layer can't turn an item on", () => {
    const site = parseSettings('{ "user.show.realName": true, "user.show.activity": false }');
    expect(shownFromSettings(resolveSettings({ site }))).toEqual(DEFAULT_SHOWN);
    const user = parseSettings('{ "user.show.realName": true, "user.show.activity": false }');
    expect(shownFromSettings(resolveSettings({ site, user }))).toMatchObject({ realName: true, activity: false });
    expect(checkSettings('{ "user.show.realName": true }', [], 'site')).toEqual([
      expect.objectContaining({ severity: 'warning', key: 'user.show.realName' }),
    ]);
    expect(checkSettings('{ "user.show.realName": true }')).toEqual([]);
  });

  it('checks values strictly and reads a bad one as the default', () => {
    expect(checkSettings('{ "user.show.realName": "yes" }')).toEqual([
      expect.objectContaining({ severity: 'error', key: 'user.show.realName' }),
    ]);
    expect(shownFromSettings(resolveSettings({ user: { 'user.show.realName': 'yes' } })).realName).toBe(false);
  });

  it('draws each item as a switch, shown to signed-in readers, in the JSON Schema too', () => {
    for (const item of USER_SHOW_ITEMS) {
      const setting = CORE_SETTINGS[userShowKey(item)];
      expect(setting).toMatchObject({ widget: 'switch', accountOnly: true, signedInOnly: true });
    }
    const schema = settingsJsonSchema('https://test.local') as { properties: Record<string, { type?: string }> };
    expect(schema.properties['user.show.claimedPapers']).toMatchObject({ type: 'boolean' });
  });

  it('writes profile.json as the choices only, which its schema takes', () => {
    const text = profileFileText({ ...DEFAULT_SHOWN, realName: true });
    expect(JSON.parse(text)).toEqual({ show: { ...DEFAULT_SHOWN, realName: true } });
    expect(profileFileSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(profileFileSchema.safeParse({ show: { realName: true }, realName: 'Ada' }).success).toBe(false);
  });

  it('lists comments by their opening words', () => {
    expect(commentExcerpt('**Nice** [result](https://x.org), see\n\n```\ncode\n```\n> quote')).toBe(
      'Nice result, see quote',
    );
    expect(commentExcerpt('x'.repeat(400))).toHaveLength(240);
  });
});

describe("a person's links", () => {
  const line = (link: object) => `${JSON.stringify({ id: 'a', ...link })}\n`;

  it('go to addresses elsewhere, on the hosts their label names', () => {
    const ok = parseLabeledLinks(
      [
        line({ id: 'h', to: 'https://ada.example.org/', label: 'homepage' }),
        line({ id: 'o', to: 'https://orcid.org/0000-0002-1825-0097', label: 'orcid' }),
        line({ id: 's', to: 'https://scholar.google.com/citations?user=abc', label: 'scholar' }),
        line({ id: 'w', to: 'arxiv:1706.03762', label: 'wrote' }),
      ].join(''),
      'user',
    );
    expect(ok).toMatchObject({
      links: [
        { target: 'https://ada.example.org/', targetKind: 'web' },
        { targetKind: 'web' },
        { targetKind: 'web' },
        { target: 'arxiv:1706.03762', targetKind: 'paper' },
      ],
    });
    expect(parseLabeledLinks(line({ to: 'https://example.org/0000', label: 'orcid' }), 'user')).toMatchObject({
      problem: expect.stringMatching(/orcid\.org/),
    });
    expect(parseLabeledLinks(line({ to: 'http://ada.example.org/', label: 'homepage' }), 'user')).toMatchObject({
      problem: expect.stringMatching(/https/),
    });
    expect(parseLabeledLinks(line({ to: 'topic:x', label: 'wrote' }), 'user')).toMatchObject({
      problem: expect.stringMatching(/paper/),
    });
  });

  it('are only on user pages', () => {
    expect(parseLabeledLinks(line({ to: 'https://ada.example.org/', label: 'homepage' }), 'paper')).toMatchObject({
      problem: expect.stringMatching(/from user pages/),
    });
    expect(parseLabeledLinks(line({ to: 'arxiv:1706.03762', label: 'wrote' }), 'topic')).toMatchObject({
      problem: expect.stringMatching(/from user pages/),
    });
  });
});
