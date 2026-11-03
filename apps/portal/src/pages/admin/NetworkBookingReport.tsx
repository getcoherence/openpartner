/**
 * Network → Bookings → a booking's report: what the creator delivered and
 * what it drove through the booking's own link, what it cost per result, and
 * share links for it (the Network's docs/campaign-reports.md). Also where the
 * brand changes what the creator may share from this booking.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api } from '../../api.js';
import { Button, Card, ErrorBanner, Page, Select } from '../../ui.js';
import { theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { BookingReportView, SHARE_LABELS, type BookingReport, type CreatorShare } from '../../lib/BookingReport.js';
import { ReportShares, type ReportShare } from '../../lib/ReportShares.js';
import { useViewOnly } from '../../lib/viewOnly.js';

export function AdminNetworkBookingReport() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  // A view-only seat reads the report; refreshing it, share links and the
  // creator's sharing level are edits.
  const viewOnly = useViewOnly();
  const key = ['admin-network-booking-report', id];
  const report = useQuery({ queryKey: key, queryFn: () => api<{ report: BookingReport }>(`/admin/network/bookings/${id}/report`), retry: false });
  const refresh = useMutation({
    mutationFn: () => api<{ report: BookingReport }>(`/admin/network/bookings/${id}/report/refresh`, { method: 'POST' }),
    onSuccess: (r) => qc.setQueryData(key, r),
  });
  const sharing = useMutation({
    mutationFn: (creatorShare: CreatorShare | null) =>
      api(`/admin/network/bookings/${id}/report-sharing`, { method: 'PATCH', body: { creatorShare } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const r = report.data?.report;
  return (
    <Page
      title="Booking report"
      actions={
        <TenantLink to="/admin/network/bookings" style={{ textDecoration: 'none' }}>
          <Button variant="secondary">Bookings</Button>
        </TenantLink>
      }
    >
      <ErrorBanner error={report.error ?? refresh.error ?? sharing.error} />
      {report.isLoading ? (
        <Card>Loading…</Card>
      ) : r ? (
        <>
          <Card>
            <BookingReportView
              report={r}
              actions={
                <>
                  {!viewOnly && (
                    <Button size="sm" variant="secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                      {refresh.isPending ? 'Refreshing…' : 'Refresh'}
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => window.print()}>
                    Print / Save as PDF
                  </Button>
                </>
              }
            />
          </Card>
          {!viewOnly && (
          <div className="op-report-noprint" style={{ display: 'grid', gap: 12, marginTop: 12 }}>
            <Card>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Share</div>
              <ReportShares
                queryKey={['admin-network-booking-report-shares', id]}
                brandOptions
                list={() => api<{ shares: ReportShare[] }>(`/admin/network/bookings/${id}/report/shares`)}
                create={(options) => api<{ url: string }>(`/admin/network/bookings/${id}/report/shares`, { method: 'POST', body: options ?? {} })}
                revoke={(shareId) => api(`/admin/network/bookings/${id}/report/shares/${shareId}/revoke`, { method: 'POST' })}
              />
            </Card>
            {r.sharing && (
              <Card>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 14 }}>
                  <span style={{ fontWeight: 600 }}>{r.creator?.name ?? 'The creator'} may share</span>
                  <Select
                    value={r.sharing.creatorShare ?? 'default'}
                    onChange={(e) => sharing.mutate(e.target.value === 'default' ? null : (e.target.value as CreatorShare))}
                    disabled={sharing.isPending}
                  >
                    <option value="default">Your default ({SHARE_LABELS[r.sharing.brandDefault]})</option>
                    {(Object.keys(SHARE_LABELS) as CreatorShare[]).map((k) => (
                      <option key={k} value={k}>
                        {SHARE_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                </label>
                {r.sharing.effective === 'none' ? (
                  <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>Their links stop working</div>
                ) : (
                  r.sharing.onCreatorStorefront && (
                    <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>On their storefront as verified work</div>
                  )
                )}
              </Card>
            )}
          </div>
          )}
        </>
      ) : null}
    </Page>
  );
}
