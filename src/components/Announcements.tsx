import type { Announcement } from '@/db/schema';
import { renderComment } from '@/server/comments/render';
import { DismissAnnouncement } from './DismissAnnouncement';

/**
 * The admins' messages at the top of the home page (`npm run announcements`), newest first, each a quiet line over a
 * rule. Rendered on the server; one this browser dismissed is left out by the page (`lib/announcements.ts`).
 */
export function Announcements({ items }: { items: Pick<Announcement, 'id' | 'body'>[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      {items.map((a) => (
        <DismissAnnouncement key={a.id} id={a.id}>
          <div className="md comment-md min-w-0 flex-1" dangerouslySetInnerHTML={{ __html: renderComment(a.body) }} />
        </DismissAnnouncement>
      ))}
    </div>
  );
}
