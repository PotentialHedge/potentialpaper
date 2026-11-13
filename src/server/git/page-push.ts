import type { Database } from '@/db';
import { canonicalPaperId, paperPath, type PaperId } from '@/lib/paper-ids';
import type { Actor } from '../pages/check';
import { receiveCommits } from '../pages/receive';
import { refreshPaperPages } from '../pages/refresh';
import { siteUrl } from '../site';
import type { ReceiveTarget } from './receive-pack';
import { pageRepo } from './repo';

/**
 * A page as the place a push goes, for any transport: its repo in Postgres, and `receiveCommits` for the
 * one ref, then the paper's pages refreshed as after a web edit (`refreshPaperPages`: Next's copies, and the
 * edge's when production has a purge token).
 */
export function pageReceiveTarget(
  database: Database,
  page: { paperId: string; identifiers: readonly PaperId[] },
  actor: Actor & { kind: 'account' },
): ReceiveTarget {
  return {
    repo: pageRepo(database, page.paperId),
    async update(update, objects) {
      const result = await receiveCommits(page.paperId, actor, update, objects, { database });
      if (result.status !== 'committed') return [];
      await refreshPaperPages(page.identifiers);
      const id = canonicalPaperId([...page.identifiers]);
      const n = result.commits.length;
      return [`${n} commit${n === 1 ? '' : 's'} added${id ? `: ${siteUrl()}${paperPath(id)}` : ''}`];
    },
  };
}
