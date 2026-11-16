import type { Database } from '@/db';
import { type PageAddress, pagePath } from '@/lib/kinds';
import type { PaperId } from '@/lib/paper-ids';
import { mailEditFollowers } from '../follows';
import type { Actor } from '../pages/check';
import { receiveCommits } from '../pages/receive';
import { refreshPages } from '../pages/refresh';
import { siteUrl } from '../site';
import type { ReceiveTarget } from './receive-pack';
import { pageRepo } from './repo';

/**
 * A page of any kind as the place a push goes, for any transport: its repo in Postgres, and `receiveCommits` for
 * the one ref, then the page's addresses refreshed as after a web edit (`refreshPages`: Next's copies, and the
 * edge's when production has a purge token), and a paper's followers mailed (`server/follows.ts`).
 */
export function pageReceiveTarget(
  database: Database,
  page: { pageId: string; address: PageAddress; identifiers: readonly PaperId[] },
  actor: Actor & { kind: 'account' },
): ReceiveTarget {
  return {
    repo: pageRepo(database, page.pageId),
    async update(update, objects) {
      const result = await receiveCommits(page.pageId, actor, update, objects, { database });
      if (result.status !== 'committed') return [];
      await refreshPages(page.address, page.identifiers);
      if (page.address.kind === 'paper') {
        void mailEditFollowers(
          page.pageId,
          actor.accountId,
          result.commits.map((c) => c.seq),
          database,
        ).catch((err) => console.error('follow mail failed', err));
      }
      const n = result.commits.length;
      return [`${n} commit${n === 1 ? '' : 's'} added: ${siteUrl()}${pagePath(page.address)}`];
    },
  };
}
