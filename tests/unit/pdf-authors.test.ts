import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authorsForEmails } from '@/server/pdfs/authors';
import { extractEmails } from '@/server/pdfs/emails';

const page = (name: string) => readFileSync(join(__dirname, 'fixtures/first-pages', name), 'utf8');

/** Each address's author by name, `null` where it isn't settled. */
function assign(raw: string, authors: string[], layout = ''): Record<string, string | null> {
  const emails = extractEmails(raw, layout);
  const found = authorsForEmails(emails, authors, raw);
  return Object.fromEntries(emails.map((e) => [e, found.has(e) ? authors[found.get(e)!] : null]));
}

describe('authorsForEmails on real first pages', () => {
  it('places every author of Attention Is All You Need, by name or by the block under the name', () => {
    const authors = [
      'Ashish Vaswani',
      'Noam Shazeer',
      'Niki Parmar',
      'Jakob Uszkoreit',
      'Llion Jones',
      'Aidan N. Gomez',
      'Łukasz Kaiser',
      'Illia Polosukhin',
    ];
    expect(assign(page('1706.03762.raw.txt'), authors, page('1706.03762.layout.txt'))).toEqual({
      'avaswani@google.com': 'Ashish Vaswani',
      'noam@google.com': 'Noam Shazeer',
      'nikip@google.com': 'Niki Parmar',
      // Nothing in `usz` spells the name: it is the address in Jakob Uszkoreit's block.
      'usz@google.com': 'Jakob Uszkoreit',
      'llion@google.com': 'Llion Jones',
      'aidan@cs.toronto.edu': 'Aidan N. Gomez',
      'lukaszkaiser@google.com': 'Łukasz Kaiser',
      'illia.polosukhin@gmail.com': 'Illia Polosukhin',
    });
  });

  it('matches full names in an IEEE footnote, whatever order the metadata lists the authors in', () => {
    const authors = ['Razan Khalifeh', 'Mohamad Yaacoub', 'Christian Gianoglio', 'Moustafa Saleh', 'Maurizio Valle'];
    expect(assign(page('2611.07779.raw.txt'), authors)).toMatchObject({
      'razan.khalifeh@edu.unige.it': 'Razan Khalifeh',
      'maurizio.valle@unige.it': 'Maurizio Valle',
      'moustafa.saleh@liu.edu.lb': 'Moustafa Saleh',
      // Not an author in this list.
      'yahya.abbass@unige.it': null,
    });
  });

  it('takes an address that spells nothing from the block of the name above it', () => {
    expect(assign(page('2611.08273.raw.txt'), ['Joonyoung Lim', 'Younghwan Yoo'])).toEqual({
      'ingyuh1015@pusan.ac.kr': 'Joonyoung Lim',
    });
  });

  it('does not guess from a line of names above a line of addresses', () => {
    // `{aditya iyer, akshayn, nora ayanian}@brown.edu`: the spaces are lost underscores, so those two
    // aren't read as addresses at all, and andy132 spells no one and sits in no block.
    expect(assign(page('2611.08361.raw.txt'), ['Aditya Iyer', 'Andy Ye', 'Akshay Narayan', 'Nora Ayanian'])).toEqual({
      'akshayn@brown.edu': 'Akshay Narayan',
      'andy132@cs.washington.edu': 'Andy Ye',
    });
  });
});

describe('authorsForEmails, when in doubt', () => {
  it('leaves an address that spells two authors equally well', () => {
    expect(assign('wang@ethz.ch', ['Wei Wang', 'Lei Wang'])).toEqual({ 'wang@ethz.ch': null });
    expect(assign('w.wang@ethz.ch', ['Wei Wang', 'Lei Wang'])).toEqual({ 'w.wang@ethz.ch': 'Wei Wang' });
  });

  it('prefers the stronger match, and needs more than a short name', () => {
    expect(assign('lei@ethz.ch', ['Lei Wang'])).toEqual({ 'lei@ethz.ch': null });
    expect(assign('alice.smith@ethz.ch', ['Alice Jones', 'Alice Smith'])).toEqual({
      'alice.smith@ethz.ch': 'Alice Smith',
    });
  });

  it('drops weak matches when several addresses land on one author', () => {
    expect(assign('aditya@brown.edu iyer@brown.edu', ['Aditya Iyer'])).toEqual({
      'aditya@brown.edu': null,
      'iyer@brown.edu': null,
    });
    expect(assign('alice.smith@ethz.ch alice.smith@gmail.com', ['Alice Smith'])).toEqual({
      'alice.smith@ethz.ch': 'Alice Smith',
      'alice.smith@gmail.com': 'Alice Smith',
    });
  });
});
