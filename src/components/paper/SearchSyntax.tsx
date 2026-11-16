import { ui } from '@/components/ui';
import { FIELD_HELP, SCOPE_HELP } from '@/lib/query';

/** Help for the search syntax (`lib/query.ts`): the home page's `?` and its filter menu on a phone. */
export function SearchSyntax() {
  return (
    <>
      <p>
        Words search titles and abstracts, or with <code>in:</code> the papers&apos; pages and reviews; the last one may
        be half-typed. <code>&quot;a phrase&quot;</code> matches in order, <code>-word</code> excludes. Terms are ANDed;
        use <code>OR</code> and <code>( )</code> to group, and <code>-</code> before a filter or group to negate it. An
        arXiv id, DOI or arXiv link opens that paper.
      </p>
      <table className={ui.table}>
        <thead>
          <tr>
            <th className={ui.th()}>Filter</th>
            <th className={ui.th()}>Means</th>
            <th className={`${ui.th()} narrow:hidden`}>Also</th>
          </tr>
        </thead>
        <tbody>
          {FIELD_HELP.map((f) => (
            <tr key={f.field}>
              <td className={`${ui.td} font-mono text-ink`}>{f.example}</td>
              <td className={ui.td}>{f.means}</td>
              <td className={`${ui.td} text-faint narrow:hidden`}>{f.aliases.map((a) => `${a}:`).join(' ')}</td>
            </tr>
          ))}
          {SCOPE_HELP.map((s) => (
            <tr key={s.example}>
              <td className={`${ui.td} font-mono text-ink`}>{s.example}</td>
              <td className={ui.td}>{s.means}</td>
              <td className={`${ui.td} text-faint narrow:hidden`} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5">
        Years take <code>: = != &gt; &lt; &gt;= &lt;=</code>; text filters take <code>:</code> and <code>!=</code>.
        Quote a value with spaces. For example: <code>(venue:iclr OR venue:neurips) diffusion year&gt;=2026</code>, or{' '}
        <code>in:reviews &quot;data leakage&quot;</code> for papers whose reviews say so, each with the files that
        matched.
      </p>
    </>
  );
}
