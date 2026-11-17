'use client';

import { useEffect, useState } from 'react';
import { findTopics, type TopicMatch } from './api';

/** The topics like `q` (`GET /api/v1/topics?q=`), asked a moment after typing stops. */
export function useTopicMatches(q: string): TopicMatch[] {
  const [matches, setMatches] = useState<TopicMatch[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      findTopics(q, controller.signal)
        .then(setMatches)
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);
  return q.trim().length < 2 ? [] : matches;
}
