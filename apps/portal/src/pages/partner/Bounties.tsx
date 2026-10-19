import { useQuery } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { formatBountyAmount, formatBountyValue, type BountyLike } from '@openpartner/db';
import { api } from '../../api.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { theme } from '../../theme.js';
import { Card, EmptyState, ErrorBanner, Page, ProgressBar, StatusPill, formatDate } from '../../ui.js';

/** One row of GET /me/bounties. */
export interface MyBounty extends BountyLike {
  id: string;
  programId: string;
  programName: string;
  name: string;
  description: string | null;
  summary: string;
  status: 'active' | 'ended';
  progress: number;
  reached: boolean;
  award: { bonusId: string; status: string; awardedAt: string } | null;
}

/**
 * Partner → Bounties: goals the brand pays a bonus for, with this partner's
 * progress toward each (docs/bounties.md §7). The goal sentence is rendered
 * by the API from the bounty's fields; the description is the brand's own
 * words, shown as plain text.
 */
export function PartnerBountiesPage() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['me-bounties'],
    queryFn: () => api<{ bounties: MyBounty[] }>('/me/bounties'),
  });
  const bounties = data?.bounties ?? [];

  return (
    <Page title="Bounties" subtitle="Reach a goal and earn a bonus on top of your commissions. Progress updates every hour.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : bounties.length === 0 ? (
        <EmptyState
          title="No bounties right now"
          hint="When a program you promote posts a bounty, it shows up here."
          icon={<Trophy size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {bounties.map((b) => (
            <BountyCard key={b.id} bounty={b} />
          ))}
        </div>
      )}
    </Page>
  );
}

function BountyCard({ bounty: b }: { bounty: MyBounty }) {
  const isMobile = useIsMobile();
  const threshold = Number(b.threshold);
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>{b.name}</span>
            {b.status === 'ended' && <StatusPill status="ended" />}
          </div>
          <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 8 }}>
            {b.programName}
            {b.endsAt ? ` · ${b.status === 'ended' ? 'ended' : 'ends'} ${formatDate(b.endsAt)}` : ''}
          </div>
          <div style={{ fontSize: 14, color: theme.text, marginBottom: 6 }}>{b.summary}</div>
          {b.description && (
            <div style={{ fontSize: 13, color: theme.textMuted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55 }}>
              {b.description}
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0, textAlign: isMobile ? 'left' : 'right' }}>
          <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Bonus</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: b.award ? theme.success : theme.text }}>
            {formatBountyAmount(b.rewardAmount, b.currency)}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <ProgressBar
          value={b.progress}
          threshold={threshold}
          label={`${formatBountyValue(b, b.progress)} of ${formatBountyValue(b, threshold)}`}
        />
      </div>
      {b.award ? (
        <div role="status" style={{ marginTop: 10, fontSize: 13, color: theme.success }}>
          {awardLine(b.award.status)}
        </div>
      ) : b.reached ? (
        <div style={{ marginTop: 10, fontSize: 13, color: theme.success }}>You&rsquo;ve reached it. Your bonus is added within the hour.</div>
      ) : null}
    </Card>
  );
}

function awardLine(status: string): string {
  switch (status) {
    case 'paid':
      return 'Earned and paid.';
    case 'approved':
      return 'Earned. It goes out with your next payout.';
    case 'reversed':
      return "This bonus was reversed: refunds took you back under the goal before it was approved.";
    default:
      return "Earned. It's paid once the program's holdback ends.";
  }
}
