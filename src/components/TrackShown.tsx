'use client';

import { useEffect } from 'react';
import { type EventData, type EventName, track } from '@/lib/track';

/**
 * Sends `event` once the page is shown, and again when `data` changes (the next page of a search, another search): an
 * event from a Server Component's render, which can't call `track` itself.
 */
export function TrackShown({ event, data }: { event: EventName; data?: EventData }) {
  const key = JSON.stringify(data ?? null);
  useEffect(() => track(event, JSON.parse(key) ?? undefined), [event, key]);
  return null;
}
