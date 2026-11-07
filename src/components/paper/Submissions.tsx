import type { ReactNode } from 'react';
import { ui } from '@/components/ui';
import { sourceName } from '@/lib/paper-ids';
import {
  formatScore,
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

/**
 * A paper's submissions and what each venue published about it: a table of the reviewers' scores, then
 * the forum's notes, laid out as acceptodds lays out a paper's reviews. Plain HTML, so the cached page
 * needs no script: a review opens as a `<details>`.
 */

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** `CC-BY-4.0` → `CC BY 4.0`, as the license names itself. */
function licenseLabel(license: string): string {
  return /^CC/.test(license) ? license.replace(/-/g, ' ').replace(/ (\d\.\d)$/, ' $1') : license;
}

function anchor(submission: Submission, externalId: string): string {
  return `note-${submission.externalId}-${externalId}`.replace(/[^\w-]/g, '_');
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

/** A note's heading: who signed it, what it is unless a review, and the day, on the right. */
function Heading({ submission, note }: { submission: Submission; note: SubmissionNote }) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span>
        <span className={ui.runIn}>{note.signature}</span>
        {note.kind !== 'review' && (
          <span className="font-sans text-[13px] text-muted"> · {noteLabel(submission, note)}</span>
        )}
      </span>
      <time dateTime={note.createdAt.toISOString()} className="font-sans text-xs text-muted">
        {DATE.format(note.createdAt)}
      </time>
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
        <h5 className="font-sans text-[13px] font-semibold text-subtle">{field.label}</h5>
        <p className="break-words whitespace-pre-wrap">{field.text}</p>
      </div>
    ));
}

function Collapsed({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer font-sans text-[13px] text-accent">{summary}</summary>
      {children}
    </details>
  );
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
    <Collapsed summary={notes.length === 1 ? '1 comment' : `${notes.length} comments`}>
      {notes.map((note) => {
        const fields = shownFields(note, formOf(submission, note));
        return (
          <div
            key={note.externalId}
            id={anchor(submission, note.externalId)}
            className="mt-3 border-l-2 border-rule pl-3"
          >
            <Heading submission={submission} note={note} />
            <Scores fields={fields} />
            <Sections fields={fields} />
          </div>
        );
      })}
    </Collapsed>
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
    <article id={anchor(submission, note.externalId)} className="mt-5 border-t border-rule pt-3">
      <Heading submission={submission} note={note} />
      <Scores fields={fields} />
      {hasText && (
        <Collapsed
          summary={`Read ${noteLabel(submission, note)
            .replace(/^Official /i, '')
            .toLowerCase()}`}
        >
          <Sections fields={fields} />
        </Collapsed>
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

function ScoreTable({ submission, number }: { submission: Submission; number: number }) {
  const table = scoreTable(submission);
  if (!table) return null;
  return (
    <div className={ui.tableScroll}>
      <table className={ui.tableCentered}>
        <caption className={ui.tableCaption}>
          <b>Table {number}:</b> The reviewers&apos; scores at {submission.venue.name}.
        </caption>
        <thead>
          <tr>
            <th className={ui.th()}>Reviewer</th>
            {table.columns.map((column) => (
              <th key={column.key} className={ui.th(true)}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map(({ note, scores }) => (
            <tr key={note.externalId}>
              <td className={ui.td}>
                <a href={`#${anchor(submission, note.externalId)}`} className="text-accent">
                  {note.signature}
                </a>
              </td>
              {scores.map((score, index) => (
                <td key={table.columns[index].key} className={`${ui.td} ${ui.num}`}>
                  {score === null ? '–' : formatScore(score)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {table.rows.length > 1 && (
          <tfoot>
            <tr className="border-t border-ink">
              <td className={`${ui.td} italic`}>Mean</td>
              {table.means.map((mean, index) => (
                <td key={table.columns[index].key} className={`${ui.td} ${ui.num}`}>
                  {mean === null ? '–' : formatScore(mean)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function SubmissionView({ submission, tableNumber }: { submission: Submission; tableNumber: number }) {
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
      <p className={ui.fine}>Updated {DATE.format(submission.fetchedAt)}.</p>
      <ScoreTable submission={submission} number={tableNumber} />
      <Forum submission={submission} />
    </section>
  );
}

export function SubmissionsSection({ submissions }: { submissions: Submission[] }) {
  return (
    <section id="submissions">
      <h2 className={ui.groupHeading}>Submissions</h2>
      {submissions.length === 0 ? (
        <p className={ui.empty}>We don&apos;t know of a submission of this paper to a venue with open reviews.</p>
      ) : (
        submissions.map((submission, index) => (
          <SubmissionView
            key={submission.venue.id}
            submission={submission}
            // Tables are numbered in page order, and only a submission with scores has one.
            tableNumber={submissions.slice(0, index).filter((earlier) => scoreTable(earlier)).length + 1}
          />
        ))
      )}
    </section>
  );
}

/** One line per submission beside the page, with the mean of its first score. */
export function SubmissionsBox({ submissions }: { submissions: Submission[] }) {
  if (submissions.length === 0) return null;
  return (
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>Submissions</h2>
      <ul className="space-y-1.5">
        {submissions.map((submission) => {
          const table = scoreTable(submission);
          const mean = table?.means[0];
          return (
            <li key={submission.venue.id}>
              <a href="#submissions" className="font-semibold text-ink">
                {submission.venue.name}
              </a>
              <div className="text-muted">{standing(submission) || 'No decision yet'}</div>
              {table && mean !== null && mean !== undefined && (
                <div className={ui.kv}>
                  <span>Mean {table.columns[0].label.toLowerCase()}</span>
                  <span className="font-mono text-[13px]">{formatScore(mean)}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
