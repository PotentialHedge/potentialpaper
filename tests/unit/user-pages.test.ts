import { describe, expect, it } from 'vitest';
import { checkSettings, CORE_SETTINGS, parseSettings, resolveSettings, settingsJsonSchema } from '@/lib/settings';
import { DEFAULT_SHOWN, shownFromSettings, USER_SHOW_SETTINGS, userShowKey } from '@/lib/user-pages';
import { cleanProfileLink, profileLinkHref } from '@/lib/profile';
import { commentExcerpt } from '@/server/user-pages';

describe('what a user page shows', () => {
  it('defaults to no real name or institution, but to the papers authored (DESIGN.md §5.3)', () => {
    expect(DEFAULT_SHOWN).toEqual({
      realName: false,
      institution: false,
      claimedPapers: true,
      activity: true,
      comments: true,
    });
    const values = resolveSettings({});
    for (const item of USER_SHOW_SETTINGS) expect(values[userShowKey(item)]).toBe(DEFAULT_SHOWN[item]);
    expect(shownFromSettings(values, false)).toEqual(DEFAULT_SHOWN);
  });

  it("takes the institution from the account's show_institution, not from a setting", () => {
    expect(CORE_SETTINGS['user.show.institution']).toBeUndefined();
    expect(shownFromSettings(resolveSettings({}), true)).toEqual({ ...DEFAULT_SHOWN, institution: true });
    expect(shownFromSettings({ 'user.show.institution': true }, false).institution).toBe(false);
    expect(checkSettings('{ "user.show.institution": true }')).toEqual([
      expect.objectContaining({ severity: 'warning', key: 'user.show.institution' }),
    ]);
  });

  it("is each account's own choice: the site layer can't turn an item on", () => {
    const site = parseSettings('{ "user.show.realName": true, "user.show.activity": false }');
    expect(shownFromSettings(resolveSettings({ site }), false)).toEqual(DEFAULT_SHOWN);
    const user = parseSettings('{ "user.show.realName": true, "user.show.activity": false }');
    expect(shownFromSettings(resolveSettings({ site, user }), false)).toMatchObject({
      realName: true,
      activity: false,
    });
    expect(checkSettings('{ "user.show.realName": true }', [], 'site')).toEqual([
      expect.objectContaining({ severity: 'warning', key: 'user.show.realName' }),
    ]);
    expect(checkSettings('{ "user.show.realName": true }')).toEqual([]);
  });

  it('checks values strictly and reads a bad one as the default', () => {
    expect(checkSettings('{ "user.show.realName": "yes" }')).toEqual([
      expect.objectContaining({ severity: 'error', key: 'user.show.realName' }),
    ]);
    expect(shownFromSettings(resolveSettings({ user: { 'user.show.realName': 'yes' } }), false).realName).toBe(false);
  });

  it('draws each item as a switch, shown to signed-in readers, in the JSON Schema too', () => {
    for (const item of USER_SHOW_SETTINGS) {
      const setting = CORE_SETTINGS[userShowKey(item)];
      expect(setting).toMatchObject({ widget: 'switch', accountOnly: true, signedInOnly: true });
    }
    const schema = settingsJsonSchema('https://test.local') as { properties: Record<string, { type?: string }> };
    expect(schema.properties['user.show.claimedPapers']).toMatchObject({ type: 'boolean' });
  });

  it('keeps a person’s links in one form, and says what is wrong with a bad one', () => {
    expect(cleanProfileLink('homepage', '  ')).toEqual({ value: null });
    expect(cleanProfileLink('homepage', 'https://ada.example/me')).toEqual({ value: 'https://ada.example/me' });
    expect(cleanProfileLink('homepage', 'http://ada.example')).toHaveProperty('problem');
    expect(cleanProfileLink('homepage', 'javascript:alert(1)')).toHaveProperty('problem');
    expect(cleanProfileLink('orcid', 'https://orcid.org/0000-0002-1825-009x')).toEqual({
      value: '0000-0002-1825-009X',
    });
    expect(cleanProfileLink('orcid', '1234')).toHaveProperty('problem');
    expect(cleanProfileLink('scholar', 'https://scholar.google.de/citations?hl=de&user=AbC_12-xyz')).toEqual({
      value: 'https://scholar.google.com/citations?user=AbC_12-xyz',
    });
    expect(cleanProfileLink('scholar', 'https://evil.example/citations?user=AbC_12-xyz')).toHaveProperty('problem');
    expect(profileLinkHref('orcid', '0000-0002-1825-0097')).toBe('https://orcid.org/0000-0002-1825-0097');
  });

  it('lists comments by their opening words', () => {
    expect(commentExcerpt('**Nice** [result](https://x.org), see\n\n```\ncode\n```\n> quote')).toBe(
      'Nice result, see quote',
    );
    expect(commentExcerpt('x'.repeat(400))).toHaveLength(240);
  });
});
