import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../../ui.js';
import {
  papi,
  friendlyPlatformError,
  type CollectionMethod,
  type InvoiceBillingState,
  type InvoiceBillingTenant,
  type PlatformOperator,
} from './lib.js';

const muted = { fontSize: 13, color: theme.textMuted, lineHeight: 1.5 } as const;
const sectionTitle = { fontSize: 15, fontWeight: 600 } as const;

function methodLabel(m: CollectionMethod | null): string {
  return m === 'send_invoice' ? 'Invoice' : m === 'charge_automatically' ? 'Card' : '—';
}

/**
 * Which brands pay OpenPartner by invoice instead of an auto-charged card
 * (docs/invoice-billing.md): the declared-country default, and per-brand
 * choices that also move a live subscription.
 */
export function InvoicingPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const state = useQuery({
    queryKey: ['platform-invoice-billing'],
    queryFn: () => papi<InvoiceBillingState>('/platform-admin/invoice-billing'),
  });
  return (
    <Page
      title="Invoicing"
      subtitle="Brands that pay each monthly invoice from Stripe’s invoice page (card or bank transfer) instead of being charged automatically."
    >
      <ErrorBanner error={state.error} />
      {state.isLoading || !state.data ? (
        <Card>Loading…</Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <DefaultsCard state={state.data} canWrite={canWrite} />
          <BrandsCard state={state.data} canWrite={canWrite} />
        </div>
      )}
    </Page>
  );
}

function DefaultsCard({ state, canWrite }: { state: InvoiceBillingState; canWrite: boolean }) {
  const qc = useQueryClient();
  const [countries, setCountries] = useState(state.settings.defaultCountries.join(', '));
  const save = useMutation({
    mutationFn: () =>
      papi('/platform-admin/invoice-billing/settings', {
        method: 'PUT',
        body: {
          defaultCountries: countries
            .split(/[\s,]+/)
            .map((c) => c.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-invoice-billing'] }),
  });
  return (
    <Card>
      <div style={sectionTitle}>Default by country</div>
      <div style={{ ...muted, marginTop: 4 }}>
        A brand whose declared country is listed pays by invoice unless you choose otherwise for it below. Only new
        subscriptions follow this: switch a subscribed brand explicitly. Invoices are due {state.defaults.daysUntilDue}{' '}
        days after they’re sent; adding partners pauses {state.defaults.graceDays} days into an overdue stretch. An
        Indian brand must give its GSTIN before it can start.
      </div>
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : null} />
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, maxWidth: 360 }}>
          <Label>Country codes</Label>
          <Input value={countries} onChange={(e) => setCountries(e.target.value.toUpperCase())} placeholder="IN" disabled={!canWrite} />
        </div>
        {canWrite && (
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
    </Card>
  );
}

function BrandsCard({ state, canWrite }: { state: InvoiceBillingState; canWrite: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const rows = state.tenants;
  const editingRow = editing ? rows.find((t) => t.tenantId === editing || t.slug === editing) : undefined;
  return (
    <Card>
      <div style={sectionTitle}>Brands</div>
      <div style={{ ...muted, marginTop: 4 }}>
        Brands on the country default, brands you set terms for, and brands whose subscription is invoiced. Overdue
        ones first.
      </div>
      <div style={{ marginTop: 12 }}>
        <Table
          columns={['Brand', 'Country', 'New subscriptions', 'Live subscription', 'Terms', 'GSTIN', '']}
          empty="No brand pays by invoice yet."
          rows={rows.map((t) => [
            <div key="b" style={{ minWidth: 0, maxWidth: 180 }}>
              <div style={{ fontSize: 13 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: theme.textDim }}>/t/{t.slug}/</div>
            </div>,
            <span key="c" style={{ fontSize: 13 }}>{t.country ?? '—'}</span>,
            <span key="m" style={{ fontSize: 13 }}>
              {methodLabel(t.terms.method)}
              <div style={{ fontSize: 12, color: theme.textDim }}>
                {t.terms.source === 'ops' ? 'set by ops' : t.terms.source === 'country' ? 'country default' : 'default'}
              </div>
            </span>,
            <span key="l" style={{ fontSize: 13 }}>
              {t.subscription.live ? (
                <>
                  {methodLabel(t.subscription.collectionMethod)} · {t.subscription.status ?? 'unknown'}
                  {t.subscription.pastDueSince ? (
                    <div style={{ fontSize: 12, color: theme.danger }}>overdue since {formatDate(t.subscription.pastDueSince)}</div>
                  ) : null}
                  {t.subscription.collectionMethod && t.subscription.collectionMethod !== t.terms.method ? (
                    <div style={{ fontSize: 12, color: theme.warn }}>differs from new subscriptions</div>
                  ) : null}
                </>
              ) : (
                <span style={{ color: theme.textDim }}>none</span>
              )}
            </span>,
            <span key="t" style={{ fontSize: 12.5 }}>
              due {t.terms.daysUntilDue}d · grace {t.terms.graceDays}d
            </span>,
            <span key="g" style={{ fontSize: 12.5, fontFamily: theme.fontMono }}>
              {t.terms.gstin ?? (t.terms.gstinRequired ? <span style={{ color: theme.warn, fontFamily: theme.fontSans }}>needed</span> : '—')}
            </span>,
            canWrite ? (
              <Button key="e" size="sm" variant="ghost" onClick={() => setEditing(editing === t.tenantId ? null : t.tenantId)}>
                {editing === t.tenantId ? 'Close' : 'Edit'}
              </Button>
            ) : null,
          ])}
        />
      </div>
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200, maxWidth: 280, flex: 1 }}>
            <Label>Another brand (slug)</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value.trim())} placeholder="acme" />
          </div>
          <Button size="sm" variant="secondary" disabled={!slug} onClick={() => setEditing(slug)}>
            Set terms
          </Button>
        </div>
      )}
      {editing && (
        <TermsEditor
          key={editing}
          refValue={editingRow?.tenantId ?? editing}
          tenant={editingRow ?? null}
          defaults={state.defaults}
          onDone={() => {
            setEditing(null);
            setSlug('');
          }}
        />
      )}
    </Card>
  );
}

function TermsEditor({
  refValue,
  tenant,
  defaults,
  onDone,
}: {
  refValue: string;
  tenant: InvoiceBillingTenant | null;
  defaults: InvoiceBillingState['defaults'];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [method, setMethod] = useState<'' | CollectionMethod>(tenant?.profile?.collectionMethod ?? (tenant ? '' : 'send_invoice'));
  const [due, setDue] = useState(String(tenant?.terms.daysUntilDue ?? defaults.daysUntilDue));
  const [grace, setGrace] = useState(String(tenant?.terms.graceDays ?? defaults.graceDays));
  const save = useMutation({
    mutationFn: () =>
      papi<{ moved: CollectionMethod | null }>(`/platform-admin/invoice-billing/tenants/${encodeURIComponent(refValue)}`, {
        method: 'PUT',
        body: { collectionMethod: method === '' ? null : method, daysUntilDue: Number(due), graceDays: Number(grace) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform-invoice-billing'] });
      onDone();
    },
  });
  const live = tenant?.subscription.live;
  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Payment terms: {tenant?.name ?? refValue}</div>
      <div style={{ ...muted, marginTop: 4 }}>
        {live
          ? 'This brand has a live subscription. Saving a different way to pay moves it in Stripe from its next invoice; an invoice already sent keeps its terms. Moving back to a card needs one on file.'
          : 'Applies when the brand starts its plan.'}
      </div>
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : null} />
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginTop: 10 }}>
        <div>
          <Label>Pays by</Label>
          <Select value={method} onChange={(e) => setMethod(e.target.value as '' | CollectionMethod)}>
            <option value="">Country default</option>
            <option value="send_invoice">Invoice (card or bank transfer)</option>
            <option value="charge_automatically">Card, charged automatically</option>
          </Select>
        </div>
        <div>
          <Label>Due after (days)</Label>
          <Input type="number" min={1} max={90} value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div>
          <Label>Overdue grace (days)</Label>
          <Input type="number" min={0} max={180} value={grace} onChange={(e) => setGrace(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save terms'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
