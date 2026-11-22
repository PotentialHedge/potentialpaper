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
    expect(partsOf('category')).toEqual(['community']);
    expect(partsOf('user')).toEqual([]);
    expect(kindsOfFileType('labeledLink')).toEqual(PAGE_KINDS.filter((kind) => kind !== 'user'));
    expect(kindsOfFileType('venue')).toEqual(['venue']);
    expect(kindsOfFileType('submission')).toEqual(['paper']);
  });

  it('parses and formats every kind of identifier', () => {
    expect(parseIdentifier('arxiv:1706.03762v5')).toEqual({
      kind: 'paper',
      id: { scheme: 'arxiv', value: '1706.03762' },
    });
    expect(parseIdentifier('venue:iclr/2027')).toEqual({ kind: 'venue', key: 'iclr/2027' });
    expect(parseIdentifier('category:linear-attention')).toEqual({ kind: 'category', key: 'linear-attention' });
    expect(parseIdentifier('user:Alice')).toEqual({ kind: 'user', key: 'alice' });
    for (const bad of ['venue:ICLR', 'category:a/b', 'paper:x', 'org:', 'nowhere:x', 'iclr', 'venue:a/b/c/d/e']) {
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
    // A category's broader categories are its own links, which roll nothing up.
    expect(parentsOf('category', 'linear-attention', { name: 'x' })).toEqual([]);
    expect(parentsOf('org', 'eth/inf', { name: 'x', parents: ['ethz-domain'] }).sort()).toEqual([
      'org:eth',
      'org:ethz-domain',
    ]);
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
      '{"id":"a","to":"arxiv:1706.03762v2","label":"extends"}\n\n{"id":"b","to":"category:x","label":"in-category"}\n',
      'paper',
    );
    expect(ok).toMatchObject({
      links: [
        { id: 'a', target: 'arxiv:1706.03762', targetKind: 'paper', line: 1 },
        { id: 'b', target: 'category:x', targetKind: 'category', line: 3 },
      ],
    });
    // A page of any kind is put in a category; only a category is one to be in.
    expect(parseLabeledLinks('{"id":"a","to":"category:x","label":"in-category"}', 'venue')).toMatchObject({
      links: [{}],
    });
    expect(parseLabeledLinks('{"id":"a","to":"venue:x","label":"in-category"}', 'venue')).toMatchObject({
      problem: expect.stringContaining('to category pages'),
    });
    expect(parseLabeledLinks('{"id":"a","to":"category:x","label":"related"}', 'category')).toMatchObject({
      links: [{}],
    });
    expect(parseLabeledLinks('{"id":"a","to":"category:x","label":"plagiarizes"}', 'paper')).toMatchObject({
      problem: expect.stringContaining('line 1'),
    });
    expect(parseLabeledLinks('not json', 'paper')).toMatchObject({ problem: expect.stringContaining('not JSON') });
  });

  it('is a file type searched by its words', () => {
    expect(fileTypeOf('community/links.jsonl')).toBe('labeledLink');
    expect(fileTypeOf('owners/links.jsonl')).toBe('labeledLink');
    expect(
      indexFile('community/links.jsonl', '{"id":"a","to":"category:x","label":"in-category","note":"Why"}\n'),
    ).toEqual([
      { kind: 'labeled-link', text: 'is in\ncategory:x\nWhy', fields: { label: 'in-category', to: 'category:x' } },
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
    expect(layoutProblem('category.json', 'venue')).toMatch(/venue pages hold/);
    expect(layoutProblem('community/10-x.md', 'user')).toMatch(/no files/);
    expect(layoutProblem('community/links.json', 'category')).toMatch(/links\.jsonl/);
    expect(layoutProblem('venue.json', 'paper')).not.toBeNull();
  });

  it('says who may write what', () => {
    expect(pathDenied('community/10-x.md', roles(), 'category')).toBeNull();
    expect(pathDenied('category.json', roles(), 'category')).toBeNull();
    expect(pathDenied('category.json', roles({ verified: false }), 'category')).toMatch(/confirm/);
    expect(pathDenied('owners/10-x.md', roles(), 'venue')).toMatch(/organisers/);
    expect(pathDenied('owners/10-x.md', roles({ owner: true }), 'venue')).toBeNull();
    expect(pathDenied('venue.json', roles(), 'venue')).toMatch(/organisers/);
    expect(pathDenied('venue.json', roles({ grants: ['venue.json'] }), 'venue')).toBeNull();
    expect(pathDenied('org.json', roles({ owner: true }), 'org')).toBeNull();
    // A person's page has no files: nobody writes one, not even the system.
    for (const path of ['owners/10-me.md', 'profile.json', '.potentialpaper/metadata.json']) {
      expect(pathDenied(path, roles({ owner: true }), 'user')).toMatch(/no files/);
      expect(pathDenied(path, { ...roles({ admin: true }), system: true }, 'user')).toMatch(/no files/);
    }
    expect(pathDenied('extensions/x/a.json', roles({ admin: true }), 'category')).toMatch(/reserved/);
    expect(pathDenied('community/links.jsonl', roles(), 'paper')).toBeNull();
    expect(pathDenied('owners/links.jsonl', roles(), 'paper')).toMatch(/authors/);
  });

  it('checks kind files and grants per kind', () => {
    expect(
      contentProblem('venue.json', '{ "name": "ICLR 2027", "dates": { "start": "2027-04-23" } }', 'venue'),
    ).toBeNull();
    expect(contentProblem('venue.json', '{ "name": "" }', 'venue')).toMatch(/venue\.json/);
    expect(contentProblem('category.json', '{ "name": "X", "broader": ["x"] }', 'category')).toMatch(/broader/);
    expect(contentProblem('.potentialpaper/metadata.json', '{ "kind": "category" }', 'venue')).toMatch(
      /"kind": "venue"/,
    );
    expect(grantProblem('venue.json', 'venue')).toBeNull();
    expect(grantProblem('org.json', 'org')).toBeNull();
    expect(grantProblem('category.json', 'category')).toMatch(/no bot/);
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
    for (const kind of ['paper', 'venue', 'org'] as const) {
      expect(layoutProblem('owners/10-a.md', kind)).toBeNull();
      expect(pathDenied('owners/10-a.md', roles(), kind)).not.toBeNull();
      expect(pathDenied('owners/10-a.md', roles({ owner: true }), kind)).toBeNull();
    }
    expect(layoutProblem('owners/10-a.md', 'category')).not.toBeNull();
    expect(layoutProblem('author/10-a.md', 'paper')).not.toBeNull();
  });
});
