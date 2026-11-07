import { ui } from '@/components/ui';

/** A plain GET form, so it works before any script has loaded. */
export function SearchForm({ query = '' }: { query?: string }) {
  return (
    <form action="/" role="search" className="flex gap-2">
      <input
        type="search"
        name="q"
        defaultValue={query}
        maxLength={200}
        aria-label="Search papers"
        placeholder="Search for a paper"
        className={ui.searchInput}
      />
      <button className={ui.searchBtn}>Search</button>
    </form>
  );
}
