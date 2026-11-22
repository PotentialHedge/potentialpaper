'use client';

import { useEffect } from 'react';
import { useSetting } from '@/lib/settings/client';

/**
 * Applies the reader's text settings to the whole site, as a class on `<html>` (`globals.css`): `ragged-text` when
 * `text.justify` is off (justified is the default, in the CSS). In the browser only, so the cached page is the same HTML for every reader.
 */
export function TextSettings() {
  const justify = useSetting<boolean>('text.justify');
  useEffect(() => {
    document.documentElement.classList.toggle('ragged-text', justify === false);
  }, [justify]);
  return null;
}
