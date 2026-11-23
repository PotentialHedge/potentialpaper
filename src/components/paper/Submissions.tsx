import { LinkedComments, LinkedDetails, Permalink } from '@/components/paper/ReviewLinks';
import { SubmissionPanels } from '@/components/plugins/NestedPanels';
import { ui } from '@/components/ui';
import { sourceName } from '@/lib/paper-ids';
import {
  formOf,
  noteLabel,
  scoreTable,
  shownFields,
  STATUS_LABELS,
  threads,
  type NoteThread,
  type ShownField,
  type Submission,
  type SubmissionNote,
} from '@/lib/submissions';
import { renderSourceText } from '@/server/comments/render';
import { AddMissing } from '@/components/paper/AddMissing';
import { Fold } from '@/components/paper/Fold';

/**
 * A paper's submissions and what each venue published about it: the forum's notes, each review with its scores,
 * laid out as acceptodds lays out a paper's reviews. Each note has a permalink (`#review-…`, `#comment-…`) that opens
 * it; without script a review still opens as a `<details>`.
 */

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** "18 Nov 2026, 09:41 UTC": in UTC, as the page is the same cached HTML for every reader. */
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** `CC-BY-4.0` → `CC BY 4.0`, as the license names itself. */
function licenseLabel(license: string): string {
  return /^CC/.test(license) ? license.replace(/-/g, ' ').replace(/ (\d\.\d)$/, ' $1') : license;
}

/** A note's permalink on the page: `#review-<id>`, `#comment-<id>`, or `#note-<id>` for a decision and the like. */
function anchor(note: SubmissionNote): string {
  const prefix = note.kind === 'review' || note.kind === 'comment' ? note.kind : 'note';
  return `${prefix}-${note.externalId}`.replace(/[^\w-]/g, '_');
}

function reviewCount(submission: Submission): number {
  return submission.notes.filter((note) => note.kind === 'review').length;
}

/** "Under review · 3 reviews", for the heading and the aside. */
function standing(submission: Submission): string {
  const status = submission.decision ?? (submission.status && STATUS_LABELS[submission.status]);
  const reviews = reviewCount(submission);
  return [status, reviews ? `${reviews} review${reviews === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
}

/**
 * A note's heading: who signed it, what it is unless a review, and on the right the note at its source and the
 * day, which is its permalink (copied on click).
 */
function Heading({ submission, note }: { submission: Submission; note: SubmissionNote }) {
  const source = note.url ? sourceName(note.url) : null;
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span>
        <span className={ui.runIn}>{note.signature}</span>
        {note.kind !== 'review' && (
          <span className="font-sans text-[13px] text-muted"> · {noteLabel(submission, note)}</span>
        )}
      </span>
      <span className="flex gap-3 font-sans text-xs text-muted">
        {note.url && (
          <a href={note.url} className="text-muted hover:text-accent hover:underline" rel="noopener" target="_blank">
            {source} ↗
          </a>
        )}
        <Permalink anchor={anchor(note)} kind={note.kind === 'comment' ? 'comment' : 'review'}>
          <time dateTime={note.createdAt.toISOString()}>{DATE.format(note.createdAt)}</time>
        </Permalink>
      </span>
    </header>
  );
}

/** The scores, and short answers such as a decision, on one wrapping line. */
function Scores({ fields }: { fields: ShownField[] }) {
  const short = fields.filter((field) => field.type !== 'text');
  if (short.length === 0) return null;
  return (
    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-sans text-[13px]">
      {short.map((field) => (
        <div key={field.key} className="flex gap-1">
          <dt className="text-muted">{field.label}</dt>
          <dd className={field.type === 'score' ? 'font-mono' : ''}>
            {field.text}
            {field.type === 'score' && field.max !== undefined && <span className="text-faint">/{field.max}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The passages, each under its label. */
function Sections({ fields }: { fields: ShownField[] }) {
  return fields
    .filter((field) => field.type === 'text')
    .map((field) => (
      <div key={field.key} className="mt-2 text-[15px]">
        {/* A comment's one passage needs no label. */}
        {field.key !== 'comment' && <h5 className="font-sans text-[13px] font-semibold text-subtle">{field.label}</h5>}
        <div className="md comment-md break-words" dangerouslySetInnerHTML={{ __html: renderSourceText(field.text) }} />
      </div>
    ));
}

/** Every reply below a note, however deep, oldest first: a forum's nesting reads poorly in a column. */
function descendants(thread: NoteThread): SubmissionNote[] {
  return thread.replies
    .flatMap((reply) => [reply.note, ...descendants(reply)])
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

function Comments({ submission, notes }: { submission: Submission; notes: SubmissionNote[] }) {
  if (notes.length === 0) return null;
  return (
    <LinkedComments
      anchors={notes.map(anchor)}
      items={notes.map((note) => (
        <Comment key={note.externalId} submission={submission} note={note} />
      ))}
    />
  );
}

/**
 * One comment as a card of its own, headed on a tinted strip, so a long exchange reads as separate turns. The one
 * a link points at is outlined (`:target`, or `data-linked` once `LinkedComments` has shown it).
 */
function Comment({ submission, note }: { submission: Submission; note: SubmissionNote }) {
  const fields = shownFields(note, formOf(submission, note));
  const title = fields.find((field) => field.key === 'title');
  const rest = fields.filter((field) => field !== title);
  return (
    <div
      id={anchor(note)}
      className="mt-3 scroll-mt-4 border border-rule bg-card target:border-accent target:ring-1 target:ring-accent data-linked:border-accent data-linked:ring-1 data-linked:ring-accent"
    >
      <div className="border-b border-rule-soft bg-highlight px-3 py-1.5">
        <Heading submission={submission} note={note} />
        {title && <p className="mt-0.5 text-[15px] font-semibold">{title.text}</p>}
      </div>
      <div className="px-3 pb-2.5">
        <Scores fields={rest} />
        <Sections fields={rest} />
      </div>
    </div>
  );
}

/**
 * A review, meta-review or decision: the scores show at once and the writing is a click away, since a
 * paper's reviews can run to pages. Replies to it fold under it.
 */
function Note({ submission, thread }: { submission: Submission; thread: NoteThread }) {
  const { note } = thread;
  const fields = shownFields(note, formOf(submission, note));
  const hasText = fields.some((field) => field.type === 'text');
  return (
    <article id={anchor(note)} className="mt-5 scroll-mt-4 border-t border-rule pt-3">
      <Heading submission={submission} note={note} />
      <Scores fields={fields} />
      {hasText && (
        <LinkedDetails
          anchor={anchor(note)}
          summary={`Read ${noteLabel(submission, note)
            .replace(/^Official /i, '')
            .toLowerCase()}`}
        >
          <Sections fields={fields} />
        </LinkedDetails>
      )}
      <Comments submission={submission} notes={descendants(thread)} />
    </article>
  );
}

/** The forum: the venue's notes, then comments on the paper itself, then one credit for them all. */
function Forum({ submission }: { submission: Submission }) {
  const forum = threads(submission.notes);
  if (forum.length === 0) {
    return <p className="mt-2 text-muted italic">The venue hasn&apos;t published any reviews yet.</p>;
  }
  const notes = forum.filter((thread) => thread.note.kind !== 'comment');
  const loose = forum.filter((thread) => thread.note.kind === 'comment');
  const licenses = [...new Set(submission.notes.map((note) => licenseLabel(note.license)))];
  const source = submission.url ? sourceName(submission.url) : null;
  return (
    <>
      {notes.map((thread) => (
        <Note key={thread.note.externalId} submission={submission} thread={thread} />
      ))}
      {loose.length > 0 && (
        <div className="mt-5 border-t border-rule pt-3">
          <h4 className={ui.runIn}>Comments on the paper</h4>
          <Comments submission={submission} notes={loose.flatMap((thread) => [thread.note, ...descendants(thread)])} />
        </div>
      )}
      {/* Owed: OpenReview's notes are CC BY 4.0, which needs a credit and a link where they are shown. */}
      <p className={ui.fine}>
        {submission.url ? (
          <a href={submission.url} className="underline" rel="noopener">
            From {source}
          </a>
        ) : (
          'From the venue'
        )}
        {licenses.length > 0 && `, ${licenses.join(', ')}`}. Authors as signed there; shown unedited.
      </p>
    </>
  );
}

function SubmissionView({ submission }: { submission: Submission }) {
  return (
    <section className="mt-5">
      <h3 className={ui.sectionHeading}>
        {submission.venue.url ? (
          <a href={submission.venue.url} rel="noopener">
            {submission.venue.name}
          </a>
        ) : (
          submission.venue.name
        )}
      </h3>
      <p className="font-sans text-sm">
        {standing(submission) || 'No decision yet'}
        {submission.url && (
          <>
            {' · '}
            <a href={submission.url} rel="noopener" className={ui.hyperref}>
              {sourceName(submission.url)}
            </a>
          </>
        )}
      </p>
      <p className={ui.fine}>Updated {DATE_TIME.format(submission.fetchedAt)} UTC.</p>
      {/* Plugins' panels for this submission (\`paper.submission\`): score standing's figure at this venue. */}
      <SubmissionPanels
        venue={{ id: submission.venue.id, name: submission.venue.name }}
        hasScores={scoreTable(submission) !== null}
      />
      <Forum submission={submission} />
    </section>
  );
}

export function SubmissionsSection({ submissions, paperPath }: { submissions: Submission[]; paperPath: string }) {
  const add = <AddMissing what="submission" paperPath={paperPath} />;
  return (
    <Fold id="submissions" title="Submissions">
      {submissions.length === 0 ? (
        <div className={ui.empty}>
          We don&apos;t know of a submission of this paper to a venue with open reviews. {add}
        </div>
      ) : (
        <>
          {submissions.map((submission) => (
            <SubmissionView key={submission.venue.id} submission={submission} />
          ))}
          <div className="mt-3 font-sans text-xs">{add}</div>
        </>
      )}
    </Fold>
  );
}

