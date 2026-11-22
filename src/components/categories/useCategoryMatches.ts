'use client';

import { useEffect, useState } from 'react';
import { findCategories, type CategoryMatch } from './api';

/** The categories like `q` (`GET /api/v1/categories?q=`), asked a moment after typing stops. */
export function useCategoryMatches(q: string): CategoryMatch[] {
  const [matches, setMatches] = useState<CategoryMatch[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      findCategories(q, controller.signal)
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
