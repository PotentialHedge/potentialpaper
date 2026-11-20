import { describe, expect, it } from 'vitest';
import {
  addressOfPath,
  addressOfRef,
  formatIdentifier,
  KINDS,
  keyProblem,
  PAGE_KINDS,
  pagePath,
  pageRefOf,
  parentsOf,
  parseIdentifier,
  partsOf,
  sourcesOf,
} from '@/lib/kinds';
import { parseLabeledLinks } from '@/lib/labeled-links';
import { PAGE_PANELS, SLOT_TITLES } from '@/lib/panels';
import { CORE_SETTINGS } from '@/lib/settings/core';
import { contentProblem, grantProblem, layoutProblem, pathDenied, type Roles } from '@/server/pages/rules';
import { fileTypeOf, indexFile, kindsOfFileType, PAGE_SCHEMAS } from '@/server/pages/schemas';

const roles = (over: Partial<Roles> = {}): Roles => ({
  system: false,
  admin: false,
  verified: true,
  owner: false,
  claimed: false,
  ...over,
});

describe('the kind registry', () => {
  it('declares every kind, with its slots, parts and file types', () => {
    for (const kind of PAGE_KINDS) {
      const info = KINDS[kind];
      expect(info.kind).toBe(kind);
      for (const slot of ['main', 'aside', 'tabs']) expect(info.slots).toContain(`${kind}.${slot}`);
      for (const type of info.fileTypes) expect(Object.keys(PAGE_SCHEMAS)).toContain(type);
      // Every built-in panel is in one of its kind's slots, which the settings form can name.
      for (const panel of PAGE_PANELS[kind]) {
        expect(info.slots).toContain(panel.slot);
        expect(SLOT_TITLES[panel.slot]).toBeTruthy();
      }
      expect(CORE_SETTINGS[`${kind}.panels.hidden`]).toBeTruthy();
    }
    expect(partsOf('paper')).toEqual(['owners', 'community']);
    expect(partsOf('venue')).toEqual(['owners', 'community']);
    expect(partsOf('topic')).toEqual(['community']);
    expect(partsOf('user')).toEqual(['owners']);
    expect(kindsOfFileType('labeledLink')).toEqual(PAGE_KINDS);
    expect(kindsOfFileType('venue')).toEqual(['venue']);
    expect(kindsOfFileType('submission')).toEqual(['paper']);
  });

  it('parses and formats every kind of identifier', () => {
    expect(parseIdentifier('arxiv:1706.03762v5')).toEqual({
      kind: 'paper',
      id: { scheme: 'arxiv', value: '1706.03762' },
    });
    expect(parseIdentifier('venue:iclr/2027')).toEqual({ kind: 'venue', key: 'iclr/2027' });
    expect(parseIdentifier('topic:linear-attention')).toEqual({ kind: 'topic', key: 'linear-attention' });
    expect(parseIdentifier('user:Alice')).toEqual({ kind: 'user', key: 'alice' });
    for (const bad of ['venue:ICLR', 'topic:a/b', 'paper:x', 'org:', 'nowhere:x', 'iclr', 'venue:a/b/c/d/e']) {
      expect(parseIdentifier(bad), bad).toBeNull();
    }
    expect(formatIdentifier(parseIdentifier('arxiv:1706.03762v5')!)).toBe('arxiv:1706.03762');
    expect(pagePath({ kind: 'venue', key: 'iclr/2027' })).toBe('/v/iclr/2027');
    expect(pagePath({ kind: 'paper', id: { scheme: 'arxiv', value: '1706.03762' } })).toBe('/abs/1706.03762');
    expect(keyProblem('org', 'eth/inf/lab')).toBeNull();
    expect(keyProblem('org', 'a/b/c/d')).toMatch(/more than 3/);
  });

  it('finds parents and sources in the address and the kind file', () => {
    expect(parentsOf('venue', 'iclr/2027', null)).toEqual(['venue:iclr']);
    expect(parentsOf('venue', 'iclr', null)).toEqual([]);
    expect(parentsOf('topic', 'linear-attention', { name: 'x', broader: ['efficient-transformers'] })).toEqual([
      'topic:efficient-transformers',
    ]);
    expect(parentsOf('org', 'eth/inf', { name: 'x', parents: ['ethz-domain'] }).sort()).toEqual([
      'org:eth',
      'org:ethz-domain',
    ]);
    expect(parentsOf('topic', 'a', { name: 'x', broader: ['a'] })).toEqual([]);
    expect(sourcesOf('venue', { name: 'x', sources: ['openreview:ICLR.cc/2027/Conference'] })).toEqual([
      'openreview:ICLR.cc/2027/Conference',
    ]);
    expect(sourcesOf('venue', { sources: 'not a list' })).toEqual([]);
  });
});

describe('labeled links', () => {
  it('checks each line against the label, the kinds and the file', () => {
    expect(parseLabeledLinks('', 'paper')).toEqual({ links: [] });
    const ok = parseLabeledLinks(
      '{"id":"a","to":"arxiv:1706.03762v2","label":"extends"}\n\n{"id":"b","to":"topic:x","label":"in-topic"}\n',
      'paper',
    );
    expect(ok).toMatchObject({
      links: [
        { id: 'a', target: 'arxiv:1706.03762', targetKind: 'paper', line: 1 },
        { id: 'b', target: 'topic:x', targetKind: 'topic', line: 3 },
      ],
    });
    expect(parseLabeledLinks('{"id":"a","to":"topic:x","label":"in-topic"}', 'venue')).toMatchObject({
      problem: expect.stringContaining('from paper pages'),
    });
    expect(parseLabeledLinks('{"id":"a","to":"topic:x","label":"related"}', 'topic')).toMatchObject({ links: [{}] });
    expect(parseLabeledLinks('{"id":"a","to":"topic:x","label":"plagiarizes"}', 'paper')).toMatchObject({
      problem: expect.stringContaining('line 1'),
    });
    expect(parseLabeledLinks('not json', 'paper')).toMatchObject({ problem: expect.stringContaining('not JSON') });
  });

  it('is a file type searched by its words', () => {
    expect(fileTypeOf('community/links.jsonl')).toBe('labeledLink');
    expect(fileTypeOf('owners/links.jsonl')).toBe('labeledLink');
    expect(indexFile('community/links.jsonl', '{"id":"a","to":"topic:x","label":"in-topic","note":"Why"}\n')).toEqual([
      { kind: 'labeled-link', text: 'is about\ntopic:x\nWhy', fields: { label: 'in-topic', to: 'topic:x' } },
    ]);
    expect(indexFile('venue.json', '{ "name": "ICLR 2027" }')).toEqual([
      { kind: 'venue', text: 'ICLR 2027', fields: { name: 'ICLR 2027' } },
    ]);
  });
});

describe('path rules per kind', () => {
  it("lays out each kind's pages", () => {
    expect(layoutProblem('venue.json', 'venue')).toBeNull();
    expect(layoutProblem('owners/10-welcome.md', 'venue')).toBeNull();
    expect(layoutProblem('owners/links.jsonl', 'venue')).toBeNull();
    expect(layoutProblem('community/links.jsonl', 'paper')).toBeNull();
    expect(layoutProblem('owners/links.jsonl', 'paper')).toBeNull();
    expect(layoutProblem('versions/v_k3x9q2ab.json', 'venue')).toMatch(/venue pages hold/);
    expect(layoutProblem('topic.json', 'venue')).toMatch(/venue pages hold/);
    expect(layoutProblem('community/10-x.md', 'user')).toMatch(/user pages hold/);
    expect(layoutProblem('community/links.json', 'topic')).toMatch(/links\.jsonl/);
    expect(layoutProblem('venue.json', 'paper')).not.toBeNull();
  });

  it('says who may write what', () => {
    expect(pathDenied('community/10-x.md', roles(), 'topic')).toBeNull();
    expect(pathDenied('topic.json', roles(), 'topic')).toBeNull();
    expect(pathDenied('topic.json', roles({ verified: false }), 'topic')).toMatch(/confirm/);
    expect(pathDenied('owners/10-x.md', roles(), 'venue')).toMatch(/organisers/);
    expect(pathDenied('owners/10-x.md', roles({ owner: true }), 'venue')).toBeNull();
    expect(pathDenied('venue.json', roles(), 'venue')).toMatch(/organisers/);
    expect(pathDenied('venue.json', roles({ grants: ['venue.json'] }), 'venue')).toBeNull();
    expect(pathDenied('org.json', roles({ owner: true }), 'org')).toBeNull();
    expect(pathDenied('owners/10-me.md', roles(), 'user')).toMatch(/only this account/);
    // A person's profile.json follows their user.show.* settings: only the site writes it.
    expect(pathDenied('profile.json', roles({ owner: true }), 'user')).toMatch(/user\.show/);
    expect(pathDenied('profile.json', roles({ admin: true }), 'user')).toMatch(/user\.show/);
    expect(pathDenied('profile.json', { ...roles(), system: true }, 'user')).toBeNull();
    expect(pathDenied('.potentialpaper/metadata.json', roles({ owner: true }), 'user')).toMatch(/system/);
    expect(pathDenied('extensions/x/a.json', roles({ admin: true }), 'topic')).toMatch(/reserved/);
    expect(pathDenied('community/links.jsonl', roles(), 'paper')).toBeNull();
    expect(pathDenied('owners/links.jsonl', roles(), 'paper')).toMatch(/authors/);
  });

  it('checks kind files and grants per kind', () => {
    expect(
      contentProblem('venue.json', '{ "name": "ICLR 2027", "dates": { "start": "2027-04-23" } }', 'venue'),
    ).toBeNull();
    expect(contentProblem('venue.json', '{ "name": "" }', 'venue')).toMatch(/venue\.json/);
    expect(contentProblem('topic.json', '{ "name": "X", "broader": ["Not A Slug"] }', 'topic')).toMatch(/broader/);
    expect(contentProblem('profile.json', '{}', 'user')).toBeNull();
    expect(contentProblem('profile.json', '{ "realName": "x" }', 'user')).not.toBeNull();
    expect(contentProblem('profile.json', '{ "show": { "realName": true, "activity": false } }', 'user')).toBeNull();
    expect(contentProblem('profile.json', '{ "show": { "email": true } }', 'user')).not.toBeNull();
    expect(contentProblem('profile.json', '{ "show": { "realName": "yes" } }', 'user')).not.toBeNull();
    expect(contentProblem('.potentialpaper/metadata.json', '{ "kind": "topic" }', 'venue')).toMatch(/"kind": "venue"/);
    expect(grantProblem('venue.json', 'venue')).toBeNull();
    expect(grantProblem('org.json', 'org')).toBeNull();
    expect(grantProblem('topic.json', 'topic')).toMatch(/no bot/);
    expect(grantProblem('venue.json')).not.toBeNull();
    expect(grantProblem('reviews/openreview/**')).toBeNull();
  });
});

describe('page addresses', () => {
  it("read a tool's path for any kind, and give the API's scheme and value", () => {
    expect(addressOfPath('abs', ['1706.03762'])).toEqual({
      kind: 'paper',
      id: { scheme: 'arxiv', value: '1706.03762' },
    });
    expect(addressOfPath('doi', ['10.1000', 'x'])).toEqual({
      kind: 'paper',
      id: { scheme: 'doi', value: '10.1000/x' },
    });
    expect(addressOfPath('v', ['iclr', '2027'])).toEqual({ kind: 'venue', key: 'iclr/2027' });
    expect(addressOfPath('u', ['Ada'])).toEqual({ kind: 'user', key: 'ada' });
    expect(addressOfPath('t', ['Not A Slug'])).toBeNull();
    expect(addressOfPath('x', ['y'])).toBeNull();
    expect(pageRefOf({ kind: 'venue', key: 'iclr/2027' })).toEqual({ scheme: 'venue', value: 'iclr/2027' });
    expect(addressOfRef({ scheme: 'venue', value: 'iclr/2027' })).toEqual({ kind: 'venue', key: 'iclr/2027' });
    expect(addressOfRef({ scheme: 'arxiv', value: '1706.03762' })).toEqual({
      kind: 'paper',
      id: { scheme: 'arxiv', value: '1706.03762' },
    });
  });

  it("put every kind's owners in owners/, written only by them", () => {
    const roles = (more: Partial<Roles> = {}): Roles => ({
      system: false,
      admin: false,
      verified: true,
      owner: false,
      claimed: false,
      ...more,
    });
    for (const kind of ['paper', 'venue', 'org', 'user'] as const) {
      expect(layoutProblem('owners/10-a.md', kind)).toBeNull();
      expect(pathDenied('owners/10-a.md', roles(), kind)).not.toBeNull();
      expect(pathDenied('owners/10-a.md', roles({ owner: true }), kind)).toBeNull();
    }
    expect(layoutProblem('owners/10-a.md', 'topic')).not.toBeNull();
    expect(layoutProblem('author/10-a.md', 'paper')).not.toBeNull();
  });
});
