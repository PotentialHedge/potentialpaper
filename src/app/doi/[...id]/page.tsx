import { PaperRoute, paperMetadata } from '@/components/paper/paper-route';

type Props = { params: Promise<{ id: string[] }> };

// Rendered on the first request, then cached: an empty list makes every address on-demand ISR.
export const revalidate = 86_400;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props) {
  return paperMetadata('doi', (await params).id);
}

export default async function Page({ params }: Props) {
  return <PaperRoute scheme="doi" segments={(await params).id} />;
}
