import { OG_SIZE, siteImage } from '@/server/og';

export const alt = 'potentialpaper: a public, editable page for every research paper';
export const size = OG_SIZE;
export const contentType = 'image/png';

/** The site's link preview, which every page without its own inherits (`server/og.tsx`). */
export default function Image() {
  return siteImage();
}
