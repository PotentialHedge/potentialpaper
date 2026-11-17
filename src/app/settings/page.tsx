import { redirect } from 'next/navigation';
import { CATEGORIES } from '@/lib/settings/form';

/** `/settings` opens on its first page. */
export default function SettingsPage() {
  redirect(`/settings/${CATEGORIES[0].id}`);
}
