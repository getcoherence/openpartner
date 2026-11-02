/**
 * Share links for a booking's report: make one (its URL shows once: only a
 * hash is kept), list them with their views, revoke one. The brand picks
 * what its links show; a creator's show what the brand allows.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { Button, ErrorBanner, formatDate } from '../ui.js';
import { theme } from '../theme.js';

export interface ReportShare {
  id: string;
  createdAt: string;
  revokedAt: string | null;
  includeResults?: boolean;
  includeCost?: boolean;
  includeReported?: boolean;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface ShareOptions {
  includeResults: boolean;
  includeCost: boolean;
  includeReported: boolean;
}

export function ReportShares({
  queryKey,
  list,
  create,
  revoke,
  brandOptions,
}: {
  queryKey: unknown[];
  list: () => Promise<{ shares: ReportShare[]; allowed?: boolean }>;
  create: (options: ShareOptions | null) => Promise<{ url: string }>;
  revoke: (shareId: string) => Promise<unknown>;
  /** The brand chooses what each link shows; a creator doesn't. */
  brandOptions?: boolean;
}) {
  const qc = useQueryClient();
  const shares = useQuery({ queryKey, queryFn: list, retry: false });
  const [options, setOptions] = useState<ShareOptions>({ includeResults: true, includeCost: false, includeReported: true });
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const make = useMutation({
    mutationFn: () => create(brandOptions ? options : null),
    onSuccess: (r) => {
      setMade(r.url);
      setCopied(false);
      void qc.invalidateQueries({ queryKey });
    },
  });
  const drop = useMutation({ mutationFn: revoke, onSuccess: () => void qc.invalidateQueries({ queryKey }) });

  if (shares.data && shares.data.allowed === false) {
    return <div style={{ fontSize: 13, color: theme.textMuted }}>The brand hasn’t allowed sharing for this booking.</div>;
  }
  const live = (shares.data?.shares ?? []).filter((s) => !s.revokedAt);
  const check = (key: keyof ShareOptions, label: string) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
      <input type="checkbox" checked={options[key]} onChange={(e) => setOptions({ ...options, [key]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <div className="op-report-noprint">
      <ErrorBanner error={shares.error ?? make.error ?? drop.error} />
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {brandOptions && (
          <>
            {check('includeResults', 'Results')}
            {check('includeCost', 'Spend')}
            {check('includeReported', 'Creator-reported numbers')}
          </>
        )}
        <Button size="sm" onClick={() => make.mutate()} disabled={make.isPending}>
          {make.isPending ? 'Making link…' : 'Make share link'}
        </Button>
      </div>
      {made && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <code style={{ fontSize: 12, background: theme.surface2, padding: '6px 8px', borderRadius: theme.radiusSm, wordBreak: 'break-all', flex: 1 }}>{made}</code>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(made);
              setCopied(true);
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </Button>
          <span style={{ fontSize: 12, color: theme.textDim, width: '100%' }}>Shown once</span>
        </div>
      )}
      {live.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {live.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: `1px solid ${theme.borderSubtle}`, fontSize: 13 }}>
              <span style={{ flex: 1, color: theme.textMuted }}>
                {formatDate(s.createdAt)}
                {brandOptions && (
                  <>
                    {' · '}
                    {[s.includeResults && 'Results', s.includeCost && 'Spend', s.includeReported && 'Reported'].filter(Boolean).join(', ') || 'Posts only'}
                  </>
                )}
              </span>
              <span style={{ color: theme.textDim }}>
                {s.viewCount.toLocaleString()} {s.viewCount === 1 ? 'view' : 'views'}
              </span>
              <Button size="sm" variant="ghost" onClick={() => drop.mutate(s.id)} disabled={drop.isPending}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
