/**
 * /reports#<token> — a booking report someone shared (the Network's
 * docs/campaign-reports.md). The token sits after `#`, so the browser never
 * sends it to a server or puts it in a Referer. The page reads it, takes it
 * out of the address bar, and posts it in a request body. What the report
 * shows is the Network's call: what the brand or creator chose to share.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '../ui.js';
import { theme } from '../theme.js';
import { BookingReportView, type BookingReport } from '../lib/BookingReport.js';

/** The token from the fragment. Read without side effects: React may call
 *  a state initializer twice. */
function readToken(): string | null {
  return window.location.hash.replace(/^#/, '') || null;
}

/** The token, which leaves the address bar once read, so a copied or
 *  bookmarked address doesn't carry it further than the link it came in. A
 *  second link opened in this tab changes only the fragment, so the page
 *  doesn't reload: its token replaces the first. */
function useFragmentToken(): string | null {
  const [token, setToken] = useState(readToken);
  useEffect(() => {
    const clear = () => {
      if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname);
    };
    const onHashChange = () => {
      const next = readToken();
      if (next) setToken(next);
      clear();
    };
    clear();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return token;
}

/** No Referer to anywhere a report links, and no search index. */
function useReportHead(): void {
  useEffect(() => {
    const added = [
      Object.assign(document.createElement('meta'), { name: 'referrer', content: 'no-referrer' }),
      Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex' }),
    ];
    for (const m of added) document.head.appendChild(m);
    const title = document.title;
    document.title = 'Booking report · OpenPartner';
    return () => {
      for (const m of added) m.remove();
      document.title = title;
    };
  }, []);
}

export function PublicReportPage() {
  useReportHead();
  const token = useFragmentToken();
  const report = useQuery({
    queryKey: ['public-report', token],
    enabled: !!token,
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const res = await fetch('/api/creator-api/reports/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) throw new Error(res.status === 429 ? 'rate_limited' : 'report_not_found');
      return ((await res.json()) as { report: BookingReport }).report;
    },
  });

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, padding: '32px 16px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {!token || report.isError ? (
          <Card>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{report.error?.message === 'rate_limited' ? 'Too many requests' : 'Report not found'}</div>
            <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6 }}>
              {report.error?.message === 'rate_limited' ? 'Try again in a minute.' : 'The link may have been revoked.'}
            </div>
          </Card>
        ) : report.isLoading || !report.data ? (
          <Card>Loading…</Card>
        ) : (
          <Card>
            <BookingReportView
              report={report.data}
              actions={
                <button
                  type="button"
                  onClick={() => window.print()}
                  style={{ background: 'none', border: `1px solid ${theme.border}`, borderRadius: theme.radiusSm, padding: '6px 10px', color: theme.text, cursor: 'pointer', fontSize: 13 }}
                >
                  Print / Save as PDF
                </button>
              }
              footer={
                <div style={{ marginTop: 20, paddingTop: 12, borderTop: `1px solid ${theme.borderSubtle}`, fontSize: 12, color: theme.textDim, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <span>
                    Measured by{' '}
                    <a href="https://openpartner.dev" target="_blank" rel="noopener noreferrer" style={{ color: theme.accentText }}>
                      OpenPartner
                    </a>
                  </span>
                  {report.data.creator?.storefrontUrl && (
                    <a href={report.data.creator.storefrontUrl} target="_blank" rel="noopener noreferrer" className="op-report-noprint" style={{ color: theme.accentText }}>
                      Work with {report.data.creator.name}
                    </a>
                  )}
                </div>
              }
            />
          </Card>
        )}
      </div>
    </div>
  );
}
