/**
 * A package's suggested rate, under its price (the Network's
 * docs/rate-suggestions.md §5): a range estimated from the creator's own
 * audience numbers, and what they've actually charged once they have
 * enough completed bookings of that kind. The creator's eyes only.
 *
 * Renders nothing when there's no suggestion, when the package has no
 * format, or on a Network that predates suggestions.
 */
import { useQuery } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import {
  formatRateRange,
  formatWhole,
  RATE_SUGGESTIONS_KEY,
  suggestionBasisText,
  type RateSuggestions,
} from './storefront-shared.js';

export function useRateSuggestions() {
  return useQuery({
    queryKey: RATE_SUGGESTIONS_KEY,
    queryFn: () => creatorApi<RateSuggestions>('/creators/me/rate-suggestions'),
    // A Network without the route answers 404: no suggestions, no retries.
    retry: false,
    staleTime: 5 * 60 * 1000,
    // The creator's own booking history: kept only while an editor shows
    // it, so it can't outlive their session in this tab.
    gcTime: 0,
  });
}

export function RateHint({ platform, format, currency }: { platform: string | null; format: string | null; currency: string }) {
  const q = useRateSuggestions();
  if (!platform || !format || !q.data) return null;
  const s = q.data.suggestions.find((x) => x.platform === platform && x.format === format);
  const h = q.data.history.find((x) => x.platform === platform && x.format === format);
  if (!s && !h) return null;
  return (
    <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 4 }} data-testid="rate-hint">
      {s && (
        <span title={suggestionBasisText(s, q.data.niche)} style={{ cursor: 'help', borderBottom: `1px dotted ${theme.textMuted}` }}>
          Suggested {formatRateRange(s.low, s.high, s.currency)}
          {currency !== s.currency ? ` (${s.currency})` : ''}
        </span>
      )}
      {s && h && ' · '}
      {h && (
        <span>
          Your last {h.count}: {formatWhole(h.median, h.currency)} median
        </span>
      )}
    </div>
  );
}
