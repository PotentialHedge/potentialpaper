import { SearchForm } from '@/components/paper/SearchForm';
import { ui } from '@/components/ui';

export default function NotFound() {
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] font-normal">Not found</h1>
      <p className="my-4">There is nothing at this address. If you were looking for a paper, try searching for it.</p>
      <SearchForm />
    </main>
  );
}
