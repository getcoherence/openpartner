import { useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api.js';

/** `value` trimmed, once it has stopped changing for `ms` — so each
 *  keystroke in a search box doesn't hit the API. */
export function useDebouncedSearch(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value.trim());
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value.trim()), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Cache key for one search over GET /partners. Under ['partners'], so the
 *  existing invalidateQueries({ queryKey: ['partners'] }) calls refresh
 *  every loaded list and picker. */
export function partnerListKey(q: string, pageSize: number) {
  return ['partners', 'list', q, pageSize] as const;
}

/**
 * GET /partners one page at a time. Programs run to tens of thousands of
 * partners, so nothing loads the whole roster: `q` is the server-side
 * name/email search and `fetchNextPage` follows the keyset cursor. The
 * previous results stay up while a new search loads (isPlaceholderData).
 */
export function usePartnerSearch<P extends { id: string }>(q: string, pageSize: number) {
  return useInfiniteQuery({
    queryKey: partnerListKey(q, pageSize),
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(pageSize) });
      if (q) qs.set('q', q);
      if (pageParam) qs.set('cursor', pageParam);
      return api<{ partners: P[]; nextCursor: string | null }>(`/partners?${qs}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}
