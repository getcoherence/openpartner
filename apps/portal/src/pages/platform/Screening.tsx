import { useQuery, useQueryClient } from '@tanstack/react-query';
import { alpha, theme } from '../../theme.js';
import { countryName } from '../../lib/CountryField.js';
import { Card, ErrorBanner, Page, SectionHeading, Table, money } from '../../ui.js';
import { HOLD_REASON_LABEL, ScreeningDetail } from './ScreeningReview.js';
import { papi, type PlatformOperator, type ScreeningOverview } from './lib.js';

/**
 * Sanctions screening against the US Consolidated Screening List. Possible
 * matches wait here for an operator to clear or confirm; held partners are
 * listed with what they're owed. Clearing a partner's match releases their
 * Stripe payouts on the brand's next run; confirming a brand's rejects it.
 */
export function ScreeningPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['platform-screening'],
    queryFn: () => papi<ScreeningOverview>('/platform-admin/screening'),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['platform-screening'] });
    void qc.invalidateQueries({ queryKey: ['platform-brands'] });
  };
  const data = state.data;

  return (
    <Page
      title="Sanctions screening"
      subtitle="Brand names, brand admins and payable partners are screened against the US Consolidated Screening List (OFAC SDN and the other federal lists). A possible match holds the partner’s Stripe payouts until you clear or confirm it."
    >
      <ErrorBanner error={state.error} />
      {state.isLoading || !data ? (
        <Card>Loading…</Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {!data.cslConfigured && (
            <div
              style={{
                background: theme.warnSoft,
                border: `1px solid ${alpha(theme.warn, 0.333)}`,
                color: theme.warn,
                padding: '10px 14px',
                borderRadius: theme.radiusSm,
                fontSize: 13,
              }}
            >
              CSL_API_KEY isn’t set, so nobody is being screened. Get a free key at developer.trade.gov and set it in
              the app spec.
            </div>
          )}

          <div>
            <SectionHeading>Needs review ({data.reviews.length})</SectionHeading>
            {data.reviews.length === 0 ? (
              <Card style={{ textAlign: 'center', color: theme.textDim, fontSize: 14, padding: '28px 24px' }}>
                No possible matches waiting.
              </Card>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {data.reviews.map((r) => (
                  <Card key={r.id}>
                    <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>
                      {r.subjectKind === 'tenant' ? 'Brand' : 'Partner'}
                      {r.subjectKind === 'partner' && (r.partnerEmail ? ` · ${r.partnerEmail}` : ' · no longer on the brand')}
                      {' · '}
                      {r.brandName ?? r.tenantId}
                      {r.brandSlug ? ` (/t/${r.brandSlug}/)` : ''}
                    </div>
                    <ScreeningDetail screening={r} canWrite={canWrite} onReviewed={refresh} />
                  </Card>
                ))}
              </div>
            )}
            <div style={{ fontSize: 12, color: theme.textDim, marginTop: 8 }}>
              A list entry scoring {data.matchScoreThreshold} or more is a possible match. A rescreen that finds only
              entries you’ve already decided on keeps your decision.
            </div>
          </div>

          <div>
            <SectionHeading>Held partners ({data.held.length})</SectionHeading>
            {data.held.length === 0 ? (
              <Card style={{ textAlign: 'center', color: theme.textDim, fontSize: 14, padding: '28px 24px' }}>
                Nobody with approved commissions is on hold.
              </Card>
            ) : (
              <Table
                columns={['Brand', 'Partner', 'Reason', 'Effect', { label: 'Owed', align: 'right' }]}
                rows={data.held.map((h) => [
                  <span>{h.brandName ?? h.tenantId}</span>,
                  <span>
                    {h.partnerName}
                    <div style={{ fontSize: 11.5, color: theme.textDim }}>{h.partnerEmail}</div>
                  </span>,
                  <span style={{ color: h.reason === 'screening_pending' ? theme.textMuted : theme.danger }}>
                    {HOLD_REASON_LABEL[h.reason]}
                    {h.country ? ` (${countryName(h.country)})` : ''}
                  </span>,
                  <span style={{ color: theme.textMuted }}>
                    {h.effect === 'held' ? 'Stripe payouts held' : 'Brand pays them itself: warned'}
                  </span>,
                  <span>{h.owed.map((o) => money(o.amount, o.currency)).join(' + ')}</span>,
                ])}
              />
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
