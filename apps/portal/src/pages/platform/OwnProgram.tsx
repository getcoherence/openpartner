import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, formatDate } from '../../ui.js';
import { papi, friendlyPlatformError, type HouseProgramState, type PlatformOperator } from './lib.js';

const muted = { fontSize: 13, color: theme.textMuted, lineHeight: 1.5 } as const;
const sectionTitle = { fontSize: 15, fontWeight: 600 } as const;

/**
 * OpenPartner's own partner program: the brand whose partners refer other
 * brands to OpenPartner. With it set, a brand signup carrying one of its
 * partners' clicks is credited there, and so is the brand's billing, through
 * that brand's Stripe App connection to OpenPartner's billing account.
 */
export function OwnProgramPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const state = useQuery({
    queryKey: ['platform-house-program'],
    queryFn: () => papi<HouseProgramState>('/platform-admin/house-program'),
  });
  return (
    <Page
      title="Own program"
      subtitle="The brand that runs OpenPartner’s own partner program, so partners are credited for the brands they refer."
    >
      <ErrorBanner error={state.error} />
      {state.isLoading || !state.data ? (
        <Card>Loading…</Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ProgramCard state={state.data} canWrite={canWrite} />
          {state.data.tenant && <StatusCard state={state.data} />}
        </div>
      )}
    </Page>
  );
}

function ProgramCard({ state, canWrite }: { state: HouseProgramState; canWrite: boolean }) {
  const qc = useQueryClient();
  const [slug, setSlug] = useState(state.tenant?.slug ?? '');
  const save = useMutation({
    mutationFn: (next: string | null) => papi<HouseProgramState>('/platform-admin/house-program', { method: 'PUT', body: { slug: next } }),
    onSuccess: (data) => {
      qc.setQueryData(['platform-house-program'], data);
      setSlug(data.tenant?.slug ?? '');
    },
  });
  return (
    <Card>
      <div style={sectionTitle}>Program brand</div>
      <div style={{ ...muted, marginTop: 4 }}>
        A visitor who clicked one of this brand’s partner links and then signs up as a brand is recorded as that
        partner’s referral: the click comes from the <code>op_ref</code> cookie op.js sets on openpartner.dev, or a{' '}
        <code>?cref=</code> on the signup page. The new brand’s billing customer then names it, so its subscription
        and invoices reach the partner too. Clear the slug to stop crediting.
      </div>
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : null} />
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, maxWidth: 320 }}>
          <Label>Brand slug</Label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().trim())}
            placeholder="openpartner"
            disabled={!canWrite}
          />
        </div>
        {canWrite && (
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(slug || null)}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
      {!state.tenant && <div style={{ ...muted, marginTop: 10 }}>Not set: no signup or billing is credited to partners.</div>}
    </Card>
  );
}

function StatusCard({ state }: { state: HouseProgramState }) {
  const tenant = state.tenant!;
  const conn = state.stripeConnection;
  return (
    <Card>
      <div style={sectionTitle}>
        {tenant.displayName} <span style={{ color: theme.textDim, fontWeight: 500 }}>/t/{tenant.slug}/</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, fontSize: 13 }}>
        <div>
          Brands referred so far: <strong>{state.referredBrands}</strong>
        </div>
        {conn ? (
          <div>
            Stripe App connected to <code>{conn.stripeAccountId}</code> ({conn.livemode ? 'live' : 'test'}) since{' '}
            {formatDate(conn.connectedAt)}
            {conn.lastEventAt ? `, last event ${formatDate(conn.lastEventAt, { relative: true })}` : ', no events yet'}. It
            should be OpenPartner’s billing account: that’s where brands’ invoices are.
          </div>
        ) : (
          <div style={{ color: theme.warn }}>
            No Stripe App connection. Signups are still credited, but billing isn’t until this brand connects the
            Stripe App to OpenPartner’s billing account.
          </div>
        )}
        {(tenant.status !== 'active' || tenant.approvalStatus !== 'approved') && (
          <div style={{ color: theme.warn }}>
            This brand isn’t live ({tenant.status}, {tenant.approvalStatus}), so its partner links serve no clicks.
          </div>
        )}
      </div>
    </Card>
  );
}
