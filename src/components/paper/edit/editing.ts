'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PaperId } from '@/lib/paper-ids';
import type { PaperVersion } from '@/lib/versions';
import { authHref } from '@/lib/return-to';

/**
 * Editing happens on the paper's page, in place: every edit link is a hash (`#edit-community-2`,
 * `#edit-author`, `#edit-links`, `#edit-picture`, `#edit-versions`), and the part it names turns into its editor. The page
 * stays the same cached HTML for every reader; who may save is asked of the API when an editor opens.
 * Back, or Cancel, closes it.
 */

const PREFIX = '#edit-';

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function targetNow(): string | null {
  return window.location.hash.startsWith(PREFIX) ? decodeURIComponent(window.location.hash.slice(PREFIX.length)) : null;
}

/** What the address asks to edit (`community-2`), or `null`. Always `null` on the server. */
export function useEditHash(): string | null {
  return useSyncExternalStore(subscribe, targetNow, () => null);
}

/** Closes whatever editor is open, without a step in the history. */
export function closeEditor() {
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/**
 * The editing target of the island that owns `matches`, or `null`. One left with unsaved text stays open
 * when another edit link is followed, so that nothing typed is lost.
 */
export function useEditing(matches: (target: string) => boolean, dirty: boolean): string | null {
  const target = useEditHash();
  const [seen, setSeen] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  if (seen !== target) {
    setSeen(target);
    if (target !== null && matches(target)) setActive(target);
    else if (!dirty) setActive(null);
  }
  return active;
}

/** Shows the editor once it opens, as the address's own target would be. */
export function useScrollIntoView(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.top < 0 || box.top > window.innerHeight * 0.6) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [ref]);
}

export type EditorPart = 'author' | 'community' | 'card' | 'versions';

export interface SectionOpened {
  part: 'author' | 'community';
  baseOid: string | null;
  section: number;
  title: string | null;
  /** The section's file in the page repo (`community/20-why-it-matters.md`), or `null` for the whole part. */
  path: string | null;
  format: 'markdown' | 'html';
  text: string;
  starter: boolean;
}

export interface CardOpened {
  part: 'card';
  thumbnail: { url: string; alt: string | null; caption: string | null } | null;
  links: { label: string; url: string }[];
  claimed: boolean;
}

export interface VersionsOpened {
  part: 'versions';
  baseOid: string | null;
  versions: PaperVersion[];
}

export type Opening<T> =
  { status: 'loading' } | { status: 'denied'; code: string; message: string } | { status: 'ready'; data: T };

/**
 * Asks the API what the editor opens with. A visitor is sent to sign in, and brought back to this editor.
 */
export function useOpened<T extends SectionOpened | CardOpened | VersionsOpened>(
  paper: PaperId,
  part: EditorPart,
  section = 0,
): Opening<T> {
  const [opening, setOpening] = useState<Opening<T>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ scheme: paper.scheme, value: paper.value, part, section: String(section) });
    fetch(`/api/v1/pages/editor?${query}`)
      .then(async (res) => {
        if (!live) return;
        if (res.status === 401) {
          const here = window.location.pathname + window.location.search + window.location.hash;
          window.location.assign(authHref('/signin', here));
          return;
        }
        const body = await res.json().catch(() => null);
        if (!live) return;
        if (res.ok) setOpening({ status: 'ready', data: body as T });
        else
          setOpening({
            status: 'denied',
            code: body?.error?.code ?? 'internal_error',
            message: body?.error?.message ?? `Something went wrong (${res.status}).`,
          });
      })
      .catch(() => live && setOpening({ status: 'denied', code: 'network', message: 'Could not reach the server.' }));
    return () => {
      live = false;
    };
  }, [paper.scheme, paper.value, part, section]);
  return opening;
}

/** An error response's message, for a save. */
export async function messageOf(res: Response): Promise<string> {
  if (res.status === 401) return 'Your session ended. Sign in again in another tab, then save.';
  if (res.status === 413) return 'The picture is too large.';
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

/** The page again, past every cache, which the commit has asked to drop the page but may not have yet. */
export function reloadAt(head: string | null, anchor = '') {
  window.location.replace(`${window.location.pathname}?v=${(head ?? Date.now().toString(16)).slice(0, 12)}${anchor}`);
}
