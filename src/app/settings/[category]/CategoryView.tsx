'use client';

import Link from 'next/link';
import { SettingsList, useSettingItems } from '@/components/settings/SettingsList';
import { ui } from '@/components/ui';
import { findCategory } from '@/lib/settings/form';

/** A core category's settings. */
export function CategoryView({ id }: { id: string }) {
  const category = findCategory(id)!;
  const { items, loaded, signedIn } = useSettingItems();
  const mine = items.filter((i) => i.category === id);
  return (
    <>
      <h2 className="font-serif text-xl font-normal">{category.title}</h2>
      <p className="mt-1 mb-3 text-subtle">{category.description}</p>
      {category.signedInOnly && loaded && !signedIn ? (
        <p className={ui.fine}>
          <Link href={`/signin?next=/settings/${id}`}>Sign in</Link> to choose what your page shows.
        </p>
      ) : (
        <div className="pl-4">
          <SettingsList items={mine} />
        </div>
      )}
    </>
  );
}
