import { ui } from '@/components/ui';

/** A plain GET form, so it works before any script has loaded. */
export function SearchForm({ query = '' }: { query?: string }) {
  return (
    <form action="/search" role="search" className="flex gap-2">
      <input
        type="search"
        name="q"
        defaultValue={query}
        maxLength={200}
        aria-label="Search papers"
        placeholder="Title, arXiv id or DOI"
        className={ui.searchInput}
      />
      <button className={ui.searchBtn}>Search</button>
    </form>
  );
}
