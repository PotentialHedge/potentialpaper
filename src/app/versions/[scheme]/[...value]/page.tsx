import type { Metadata } from 'next';
import {
  editHref,
  first,
  ToolHeader,
  toolPaper,
  toolPath,
  type ToolParams,
  type ToolSearchParams,
} from '@/components/paper/page-tools';
import { ui } from '@/components/ui';
import { evidenceLabel } from '@/lib/evidence';
import type { DiffBlock, DiffPart } from '@/lib/text-diff';
import { formatVersionDate, VERSION_KIND_LABELS, versionStanding, type PaperVersion } from '@/lib/versions';
import { compareVersions, currentVersions, type Comparison } from '@/server/versions';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams; searchParams: ToolSearchParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paper } = await toolPaper('versions', params);
  return { title: `Versions of ${paper.title} · PotentialPaper`, robots: { index: false, follow: true } };
}

/** Words as they changed: removed struck through in red, added in green, the rest as it was. */
function Marked({ parts }: { parts: DiffPart[] }) {
  return parts.map((part, i) =>
    part.kind === 'same' ? (
      <span key={i}>{part.text}</span>
    ) : part.kind === 'removed' ? (
      <del key={i} className="bg-[#fbe9e9] text-down">
        {part.text}
      </del>
    ) : (
      <ins key={i} className="bg-[#e6f4ea] text-up no-underline">
        {part.text}
      </ins>
    ),
  );
}

function Side({ version, side }: { version: PaperVersion; side: 'A' | 'B' }) {
  const standing = versionStanding(version);
  return (
    <div className={ui.box}>
      <p className="text-xs text-faint">{side}</p>
      <p className="font-semibold">
        {version.url ? (
          <a href={version.url} rel="noopener">
            {version.label}
          </a>
        ) : (
          version.label
        )}
        <span className={ui.badge}>{VERSION_KIND_LABELS[version.kind].toLowerCase()}</span>
      </p>
      <p className="text-muted">{[formatVersionDate(version.date), standing].filter(Boolean).join(' · ') || '—'}</p>
      <p className="mt-1">
        {version.pdf ? (
          <a href={version.pdf.url} rel="noopener">
            PDF
          </a>
        ) : (
          <span className="text-faint">No PDF</span>
        )}
        {version.evidence?.map((url, i) => (
          <a key={url} href={url} rel="noopener nofollow" className="ml-2 text-xs" title={url}>
            [{i + 1}] {evidenceLabel(url)}
          </a>
        ))}
      </p>
      {version.note && <p className="mt-1 text-xs text-subtle">{version.note}</p>}
    </div>
  );
}

function Picker({ versions, name, value }: { versions: PaperVersion[]; name: 'a' | 'b'; value: string }) {
  return (
    <select
      name={name}
      defaultValue={value}
      aria-label={name === 'a' ? 'Version A' : 'Version B'}
      className={`${ui.input} mb-0 w-auto`}
    >
      {versions.map((v) => (
        <option key={v.id} value={v.id}>
          {[formatVersionDate(v.date), v.label].filter(Boolean).join(' · ')}
          {v.pdf ? '' : ' (no PDF)'}
        </option>
      ))}
    </select>
  );
}

function Blocks({ blocks }: { blocks: DiffBlock[] }) {
  return (
    <div className="mt-3 space-y-2 border border-rule bg-card p-3 font-serif text-[15px] leading-relaxed">
      {blocks.map((block, i) => {
        if (block.kind === 'skip') {
          return (
            <p key={i} className="text-center font-sans text-xs text-faint">
              ⋯ {block.count} unchanged sentence{block.count === 1 ? '' : 's'} ⋯
            </p>
          );
        }
        if (block.kind === 'same') {
          return (
            <p key={i} className="text-subtle">
              {block.sentences.join(' ')}
            </p>
          );
        }
        return (
          <p key={i} className="border-l-2 border-frame pl-2">
            {block.words ? (
              <Marked parts={block.words} />
            ) : (
              <>
                {block.removed.length > 0 && (
                  <del className="block bg-[#fbe9e9] text-down">{block.removed.join(' ')}</del>
                )}
                {block.added.length > 0 && (
                  <ins className="block bg-[#e6f4ea] text-up no-underline">{block.added.join(' ')}</ins>
                )}
              </>
            )}
          </p>
        );
      })}
    </div>
  );
}

function TextSection({
  text,
  labels,
  editPath,
}: {
  text: Comparison['text'];
  labels: [string, string];
  editPath: string;
}) {
  switch (text.status) {
    case 'same':
      return <p className={ui.empty}>Both versions have the same PDF.</p>;
    case 'no_pdf':
      return (
        <p className={ui.empty}>
          {text.missing.length === 2
            ? 'Neither version has a PDF here'
            : `${text.missing[0] === 'a' ? labels[0] : labels[1]} has no PDF here`}
          , so their text can&apos;t be compared.{' '}
          <a href={editPath} rel="nofollow">
            Add one
          </a>
          .
        </p>
      );
    case 'pending':
      return (
        <p className={ui.empty}>
          The text of a PDF here hasn&apos;t been read yet. That takes a minute or two after a PDF is added: reload
          shortly.
        </p>
      );
    case 'too_different':
      return <p className={ui.empty}>The two texts are too different to compare sentence by sentence.</p>;
    case 'diff': {
      const { stats } = text.diff;
      const kept = stats.sentencesA === 0 ? 0 : Math.round((100 * stats.unchanged) / stats.sentencesA);
      const pages = text.pages[0] && text.pages[1] ? `${text.pages[0]} → ${text.pages[1]} pages · ` : '';
      return (
        <>
          <p className="font-sans text-sm">
            {pages}
            <span className="text-down">−{stats.removed}</span> / <span className="text-up">+{stats.added}</span>{' '}
            sentences · {kept}% of A unchanged
          </p>
          {stats.removed + stats.added === 0 ? (
            <p className={ui.empty}>The text is the same; only the layout differs.</p>
          ) : (
            <Blocks blocks={text.diff.blocks} />
          )}
          <p className={ui.fine}>
            The PDFs&apos; text, sentence by sentence, so a change of layout or template doesn&apos;t show. Figures
            aren&apos;t compared, and equations and tables only as far as their text survives. Email addresses are
            hidden.
          </p>
        </>
      );
    }
  }
}

export default async function VersionsPage({ params, searchParams }: Props) {
  const query = await searchParams;
  const a = first(query.a) ?? '';
  const b = first(query.b) ?? '';
  const found = await toolPaper('versions', params, new URLSearchParams({ a, b }).toString());
  const versions = await currentVersions(found.paper.id);
  const comparison =
    a && b
      ? await compareVersions(found.paper.id, { a, b }, { title: found.paper.title, abstract: found.paper.abstract })
      : null;
  const pagePath = toolPath('versions', found.id);
  return (
    <main className={ui.page}>
      <ToolHeader paper={found} tool="versions" title="Comparing versions" />
      {versions.length < 2 ? (
        <p className={ui.empty}>
          This paper has {versions.length === 0 ? 'no versions' : 'one version'} recorded, so there is nothing to
          compare. Add them on the paper&apos;s page, under Versions.
        </p>
      ) : (
        <>
          <form action={pagePath} method="get" className="mt-4 flex flex-wrap items-center gap-2 font-sans text-sm">
            <Picker versions={versions} name="a" value={comparison?.a.id ?? (a || versions[0].id)} />
            <span className="text-muted">with</span>
            <Picker versions={versions} name="b" value={comparison?.b.id ?? (b || versions[versions.length - 1].id)} />
            <button type="submit" className={ui.btn({ inline: true, ghost: true, flush: true })}>
              Compare
            </button>
          </form>
          {!comparison ? (
            <p className={ui.empty}>Choose two versions to compare.</p>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-2 gap-3 narrow:grid-cols-1">
                <Side version={comparison.a} side="A" />
                <Side version={comparison.b} side="B" />
              </div>
              <h2 className={ui.groupHeading}>Title</h2>
              <p className="font-serif text-[17px]">
                {comparison.title ? (
                  <Marked parts={comparison.title} />
                ) : (
                  <>
                    {comparison.a.title ?? found.paper.title} <span className={ui.badge}>unchanged</span>
                  </>
                )}
              </p>
              <h2 className={ui.groupHeading}>Abstract</h2>
              {comparison.abstract ? (
                <p className="font-serif leading-relaxed">
                  <Marked parts={comparison.abstract} />
                </p>
              ) : comparison.a.abstract || comparison.b.abstract ? (
                <p className={ui.empty}>The same in both.</p>
              ) : (
                <p className={ui.empty}>Neither version records its own abstract.</p>
              )}
              <h2 className={ui.groupHeading}>Text</h2>
              <TextSection
                text={comparison.text}
                labels={[comparison.a.label, comparison.b.label]}
                editPath={editHref(found.id, 'versions')}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
