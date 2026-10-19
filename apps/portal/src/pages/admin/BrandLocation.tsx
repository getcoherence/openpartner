import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, X } from 'lucide-react';
import { ApiError, api } from '../../api.js';
import { alpha, theme } from '../../theme.js';
import { Button } from '../../ui.js';
import { CountryField, countryErrorMessage } from '../../lib/CountryField.js';

interface LocationState {
  required: boolean;
  country: string | null;
  outsideOccupiedRegions: boolean | null;
}

/** Whether this brand still has to say where it's based (hosted only). */
export function useBrandLocationMissing(enabled: boolean): boolean {
  const q = useQuery({
    queryKey: ['account-location'],
    queryFn: () => api<LocationState>('/account/location'),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return !!q.data?.required && !q.data.country;
}

/**
 * The one-time question for brands that signed up before the platform
 * asked where they're based. The X only hides it for this visit.
 */
export function BrandLocationPrompt({ isMobile }: { isMobile: boolean }) {
  const qc = useQueryClient();
  const [hidden, setHidden] = useState(false);
  const [country, setCountry] = useState('');
  const [outsideOccupiedRegions, setOutsideOccupiedRegions] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>('/account/location', {
        method: 'PUT',
        body: { country, ...(country === 'UA' ? { outsideOccupiedRegions } : {}) },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account-location'] }),
  });
  if (hidden) return null;

  const error = save.error
    ? (countryErrorMessage(save.error instanceof ApiError ? save.error.message : String(save.error)) ??
      'Could not save — try again.')
    : null;
  const incomplete = !country || (country === 'UA' && !outsideOccupiedRegions);

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: isMobile ? '16px 16px 0' : '24px 40px 0' }}>
      <div
        role="region"
        aria-label="Where is your business based?"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          background: theme.accentSoft,
          border: `1px solid ${alpha(theme.accent, 0.333)}`,
          borderRadius: theme.radiusMd,
          padding: '14px 16px',
        }}
      >
        <MapPin size={18} style={{ color: theme.accentText, flexShrink: 0, marginTop: 2 }} />
        <form
          style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.55, color: theme.text }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!incomplete) save.mutate();
          }}
        >
          <strong>Where is your business based?</strong>
          <p style={{ margin: '4px 0 10px', color: theme.textMuted }}>
            We need this once for every brand on OpenPartner.
          </p>
          <div style={{ maxWidth: 360 }}>
            <CountryField
              id="brand-location-country"
              value={country}
              onChange={setCountry}
              outsideOccupiedRegions={outsideOccupiedRegions}
              onOutsideOccupiedRegionsChange={setOutsideOccupiedRegions}
              selectStyle={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 13,
                background: theme.surface2,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusSm,
                color: theme.text,
              }}
            />
          </div>
          {error && <div style={{ color: theme.danger, fontSize: 13, marginTop: 8 }}>{error}</div>}
          <div style={{ marginTop: 10 }}>
            <Button type="submit" disabled={incomplete || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
        <button
          type="button"
          onClick={() => setHidden(true)}
          aria-label="Answer later"
          title="Answer later"
          style={{ background: 'transparent', border: 'none', color: theme.textMuted, cursor: 'pointer', padding: 2, display: 'inline-flex', flexShrink: 0 }}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
