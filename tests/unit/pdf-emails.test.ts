import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractEmails } from '@/server/pdfs/emails';

/** Excerpts of real first pages, as `pdftotext -f 1 -l 1 -raw` (and `-layout`) print them. */
const page = (name: string) => readFileSync(join(__dirname, 'fixtures/first-pages', name), 'utf8');

describe('extractEmails on real first pages', () => {
  it('reads one address under each author, past the footnote markers (Attention Is All You Need)', () => {
    expect(extractEmails(page('1706.03762.raw.txt'), page('1706.03762.layout.txt'))).toEqual([
      'avaswani@google.com',
      'noam@google.com',
      'nikip@google.com',
      'usz@google.com',
      'llion@google.com',
      'aidan@cs.toronto.edu',
      'lukaszkaiser@google.com',
      'illia.polosukhin@gmail.com',
    ]);
  });

  it('expands a group in braces, with spaces after the commas', () => {
    expect(extractEmails(page('2611.07726.raw.txt'))).toEqual([
      'm.reza.alizadeh@ut.ac.ir',
      'zakiye.rostamirad@ut.ac.ir',
      'arman.barghi@ut.ac.ir',
      'akalhor@ut.ac.ir',
      'm.nayeri@ut.ac.ir',
      'm.t.masouleh@ut.ac.ir',
    ]);
  });

  it('expands groups without spaces, beside lone addresses on the same lines', () => {
    expect(extractEmails(page('2611.07959.raw.txt')).sort()).toEqual(
      [
        'chen-gh23@mails.tsinghua.edu.cn',
        'rao7jun@gmail.com',
        'libh19@tsinghua.org.cn',
        'wanghj20@tsinghua.org.cn',
        'tiansongtao.2020@tsinghua.org.cn',
        'yuzx19@tsinghua.org.cn',
        'xiaojun.meng@huawei.com',
        'yuanpeng126@huawei.com',
        'weijiansheng@huawei.com',
        'xieye-xin@qq.com',
        'liuxuebo@hit.edu.cn',
      ].sort(),
    );
  });

  it('joins an address broken after a hyphen, and not the other column in layout mode', () => {
    const emails = extractEmails(page('2611.07808.raw.txt'), page('2611.07808.layout.txt'));
    expect(emails.sort()).toEqual(
      ['namhs501@inha.edu', 'jungwoo.cho@inha.ac.kr', 'haktae.lee@inha.ac.kr', 'seokhwan-lee@koreanair.com'].sort(),
    );
    // The half on the second line is not taken for an address of its own.
    expect(emails).not.toContain('lee@koreanair.com');
  });

  it('reads semicolon lists in an IEEE-style footnote', () => {
    expect(extractEmails(page('2611.07779.raw.txt'))).toEqual([
      'razan.khalifeh@edu.unige.it',
      'mohamad.yaacoub@edu.unige.it',
      'christian.gianoglio@unige.it',
      'maurizio.valle@unige.it',
      'yahya.abbass@unige.it',
      'moustafa.saleh@liu.edu.lb',
    ]);
    expect(extractEmails(page('2611.07953.raw.txt'))).toHaveLength(11);
  });

  it('strips angle brackets and the full stop after them', () => {
    expect(extractEmails(page('2611.07736.raw.txt'))).toEqual(['david.berghaus@iais.fraunhofer.de']);
  });

  it('lower-cases, and ignores the footnote markers on names', () => {
    expect(extractEmails(page('2611.07866.raw.txt'))).toEqual([
      'supersusu@tencent.com',
      'echokong@tencent.com',
      'raycheng@tencent.com',
      'felixzhuo@tencent.com',
      'gavinzli@tencent.com',
    ]);
    expect(extractEmails('Nikita.Kuzmin@skoltech.ru')).toEqual(['nikita.kuzmin@skoltech.ru']);
  });

  it('finds nothing on an anonymous ICLR submission, despite pass@k and the like', () => {
    expect(extractEmails(page('iclr2027-anonymous.raw.txt'))).toEqual([]);
    expect(extractEmails('NDCG@10, MRR@10, Acc@0.5 s, TPR@5%FPR, Pass@128, Hit@1, MT@4.')).toEqual([]);
  });
});

describe('extractEmails on what PDFs do to addresses', () => {
  it('expands groups split by commas, bars or semicolons, in any bracket, across lines', () => {
    expect(extractEmails('{alice, bob}@ethz.ch')).toEqual(['alice@ethz.ch', 'bob@ethz.ch']);
    expect(extractEmails('{alice,bob}@inf.ethz.ch')).toEqual(['alice@inf.ethz.ch', 'bob@inf.ethz.ch']);
    expect(extractEmails('{alice | bob}@ethz.ch')).toEqual(['alice@ethz.ch', 'bob@ethz.ch']);
    expect(extractEmails('{alice; bob}@ethz.ch')).toEqual(['alice@ethz.ch', 'bob@ethz.ch']);
    expect(extractEmails('[alice,bob]@ethz.ch (alice2, carol)@epfl.ch')).toEqual([
      'alice@ethz.ch',
      'bob@ethz.ch',
      'alice2@epfl.ch',
      'carol@epfl.ch',
    ]);
    expect(extractEmails('{alice,\nbob}\n@ethz.ch')).toEqual(['alice@ethz.ch', 'bob@ethz.ch']);
  });

  it('joins addresses broken around the @ or inside the domain', () => {
    expect(extractEmails('alice@inf.\nethz.ch')).toEqual(['alice@inf.ethz.ch']);
    expect(extractEmails('alice\n@ethz.ch')).toEqual(['alice@ethz.ch']);
    expect(extractEmails('alice@\nethz.ch')).toEqual(['alice@ethz.ch']);
  });

  it('does not run a sentence on into an address', () => {
    expect(extractEmails('Write to alice@ethz.ch.\nnext we describe')).toEqual(['alice@ethz.ch']);
    expect(extractEmails('ETH Zurich.\nalice@ethz.ch')).toEqual(['alice@ethz.ch']);
  });

  it('drops footnote markers after the address', () => {
    expect(extractEmails('alice@ethz.ch* bob@ethz.ch† carol@ethz.ch‡, dan@ethz.ch¹ erin@ethz.ch2')).toEqual([
      'alice@ethz.ch',
      'bob@ethz.ch',
      'carol@ethz.ch',
      'dan@ethz.ch',
      'erin@ethz.ch',
    ]);
  });

  it('normalizes ligatures, full-width characters and zero-width characters', () => {
    expect(extractEmails('ﬁona@ethz.ch')).toEqual(['fiona@ethz.ch']);
    expect(extractEmails('alice＠ethz．ch')).toEqual(['alice@ethz.ch']);
    expect(extractEmails('ali​ce@et­hz.ch﻿')).toEqual(['alice@ethz.ch']);
  });

  it('drops templates and placeholders', () => {
    expect(
      extractEmails(
        'firstname.lastname@ethz.ch {firstname.lastname}@epfl.ch first.last@ethz.ch email@domain.com ' +
          'anonymous@iclr.cc author@anonymous.org name@example.com alice@example.org',
      ),
    ).toEqual([]);
  });

  it('needs a real top-level domain, and deduplicates', () => {
    expect(extractEmails('a@b.c a@foo a@x.zzzz figure@2x.png accuracy@k.The')).toEqual([]);
    expect(extractEmails('dromero@crm.cat')).toEqual(['dromero@crm.cat']);
    expect(extractEmails('Alice@ETHZ.ch alice@ethz.ch', 'alice@ethz.ch')).toEqual(['alice@ethz.ch']);
    expect(extractEmails('ceo@startup.ai hi@lab.io x.y@mit.edu')).toEqual([
      'ceo@startup.ai',
      'hi@lab.io',
      'x.y@mit.edu',
    ]);
  });
});
