import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CATEGORIES, findCategory } from '@/lib/settings/form';
import { CategoryView } from './CategoryView';

type Params = { params: Promise<{ category: string }> };

export function generateStaticParams() {
  return CATEGORIES.map((c) => ({ category: c.id }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const category = findCategory((await params).category);
  return { title: `${category?.title ?? 'Settings'} · Settings · potentialpaper`, robots: { index: false } };
}

/** `/settings/<category>`: one category of the core settings (`lib/settings/form.ts`). */
export default async function CategoryPage({ params }: Params) {
  const category = findCategory((await params).category);
  if (!category) notFound();
  return <CategoryView id={category.id} />;
}
