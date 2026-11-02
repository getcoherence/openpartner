/**
 * /creator/bookings/:id/report — a delivered booking's report, as the
 * creator sees it (the Network's docs/campaign-reports.md): the posts, the
 * results through the booking's own link, and share links when the brand
 * allows it. For a post we can't read (LinkedIn, X, a website), the creator
 * can add their own numbers, shown as "Reported by the creator".
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, ErrorBanner, Input, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import { BookingReportView, type BookingReport, type ReportPost } from '../../lib/BookingReport.js';
import { ReportShares, type ReportShare } from '../../lib/ReportShares.js';

type Counts = { views: string; likes: string; comments: string; shares: string };

function ReportedNumbers({ post, bookingId, onSaved }: { post: ReportPost; bookingId: string; onSaved: (r: BookingReport) => void }) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Counts>({
    views: post.reported?.views?.toString() ?? '',
    likes: post.reported?.likes?.toString() ?? '',
    comments: post.reported?.comments?.toString() ?? '',
    shares: post.reported?.shares?.toString() ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const n = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.floor(Number(s))));
      return creatorApi<{ report: BookingReport }>(`/creators/me/bookings/${encodeURIComponent(bookingId)}/reported-stats`, {
        method: 'PUT',
        body: { url: post.url, views: n(counts.views), likes: n(counts.likes), comments: n(counts.comments), shares: n(counts.shares) },
      });
    },
    onSuccess: (r) => {
      setOpen(false);
      onSaved(r.report);
    },
  });
  // Numbers from YouTube, Instagram or TikTok win: a post with them takes none.
  if (post.youtube || post.social) return null;
  if (!open) {
    return (
      <div className="op-report-noprint" style={{ marginTop: 6 }}>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {post.reported ? 'Edit your numbers' : 'Add your numbers'}
        </Button>
      </div>
    );
  }
  const impressions = post.label === 'linkedin' || post.label === 'x';
  const field = (key: keyof Counts, label: string) => (
    <label style={{ display: 'grid', gap: 4, fontSize: 12, color: theme.textMuted }}>
      {label}
      <Input inputMode="numeric" value={counts[key]} onChange={(e) => setCounts({ ...counts, [key]: e.target.value.replace(/[^0-9]/g, '') })} style={{ width: 120 }} />
    </label>
  );
  return (
    <div className="op-report-noprint" style={{ marginTop: 8 }}>
      <ErrorBanner error={save.error} />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {field('views', impressions ? 'Impressions' : 'Views')}
        {field('likes', 'Likes')}
        {field('comments', 'Comments')}
        {field('shares', 'Shares')}
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function CreatorBookingReportPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const key = ['creator-booking-report', id];
  const report = useQuery({
    queryKey: key,
    queryFn: () => creatorApi<{ report: BookingReport }>(`/creators/me/bookings/${encodeURIComponent(id)}/report`),
    retry: false,
  });
  const r = report.data?.report;
  const closed = r?.window?.closed ?? false;

  return (
    <Page
      title="Booking report"
      actions={
        <Link to="/creator/bookings" style={{ textDecoration: 'none' }}>
          <Button variant="secondary">Bookings</Button>
        </Link>
      }
    >
      <ErrorBanner error={report.error} />
      {report.isLoading ? (
        <Card>Loading…</Card>
      ) : r ? (
        <>
          <Card>
            <BookingReportView
              report={r}
              actions={
                <Button size="sm" variant="secondary" onClick={() => window.print()}>
                  Print / Save as PDF
                </Button>
              }
              postEditor={closed ? undefined : (p) => <ReportedNumbers post={p} bookingId={id} onSaved={(next) => qc.setQueryData(key, { report: next })} />}
            />
            {r.trackedUrls && r.trackedUrls.length > 0 && (
              <div className="op-report-noprint" style={{ fontSize: 13, color: theme.textMuted, marginTop: 14 }}>
                Booking link: <code style={{ wordBreak: 'break-all' }}>{r.trackedUrls[0]}</code>
              </div>
            )}
          </Card>
          <Card style={{ marginTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Share</div>
            <ReportShares
              queryKey={['creator-booking-report-shares', id]}
              list={() => creatorApi<{ shares: ReportShare[]; allowed: boolean }>(`/creators/me/bookings/${encodeURIComponent(id)}/report/shares`)}
              create={() => creatorApi<{ url: string }>(`/creators/me/bookings/${encodeURIComponent(id)}/report/shares`, { method: 'POST', body: {} })}
              revoke={(shareId) =>
                creatorApi(`/creators/me/bookings/${encodeURIComponent(id)}/report/shares/${encodeURIComponent(shareId)}/revoke`, { method: 'POST', body: {} })
              }
            />
          </Card>
        </>
      ) : null}
    </Page>
  );
}
