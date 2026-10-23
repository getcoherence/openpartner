import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Download, FilePlus2, FileSpreadsheet, RefreshCw, Send, Trash2 } from 'lucide-react';
import { ApiError, api, apiDownload, saveBlob } from '../api.js';
import { TenantLink } from '../tenant-link.js';
import { alpha, theme } from '../theme.js';
import { Button, Card, ErrorBanner, Select, Table, formatDate, money } from '../ui.js';
import { HOLD_REASON, type HoldReason } from './payout-holds.js';
import { usePaypalConnections, type PaypalEnvironment } from './admin/PaypalPayoutsCard.js';
import { rateDateLabel, rateLabel, withdrawalNote } from './payout-sent.js';

type Provider = 'paypal' | 'wise';
type DoNotPay = 'country_not_supported' | 'screening_confirmed';
type Exclusion =
  | 'no_payout_details'
  | 'details_unreadable'
  | 'pay_individually'
  | 'currency_not_supported'
  | 'details_incomplete'
  | 'over_paypal_limit'
  | DoNotPay;

/** GET /payouts/runs */
interface RunSummary {
  runId: string;
  createdAt: string;
  pendingCount: number;
  pendingTotals: Array<{ currency: string; amount: string }>;
}

/** GET /payouts/runs/:runId */
interface ManualRun {
  runId: string;
  createdAt: string;
  pendingCount: number;
  /** `sendAs`: balances PayPal can't send in `currency` (INR), which Pay
   *  with PayPal sends in this currency at a quoted rate. No file. */
  ready: Array<{ provider: Provider; currency: string; sendAs?: string | null; count: number; total: string }>;
  exports: Array<{
    exportId: string;
    provider: Provider;
    currency: string;
    createdAt: string;
    createdBy: 'admin' | 'api';
    pendingCount: number;
    pendingTotal: string;
    changedCount: number;
    doNotPayCount: number;
  }>;
  inPaypalBatches?: number;
  excluded: Array<{ reason: Exclusion; count: number }>;
}

interface PaypalItem {
  itemId: string;
  status: string;
  transactionId: string | null;
  error: string | null;
}

/** A payout a PayPal batch sends in another currency, as stamped. */
interface Conversion {
  sourceAmount: string;
  sourceCurrency: string;
  sentAmount: string;
  sentCurrency: string;
  rate: string;
  rateDate: string;
}

/** GET /payouts/runs/:runId/payouts */
interface RunPayout {
  payoutId: string;
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  amount: string;
  currency: string;
  destination: {
    method: 'paypal' | 'bank' | 'upi' | 'other';
    country: string | null;
    summary: string | null;
    updatedAt: string;
    updatedBy: 'partner' | 'admin' | 'api';
  } | null;
  export: {
    exportId: string;
    provider: Provider;
    via?: 'file' | 'api';
    createdAt: string;
    reference: string | null;
    destinationChanged: boolean;
    paypal?: PaypalItem | null;
    conversion?: Conversion | null;
  } | null;
  ready: Provider | null;
  sendAs?: string | null;
  excluded: Exclusion | null;
  complianceWarning: HoldReason | null;
  doNotPay: DoNotPay | null;
}

/** GET /payouts/runs/:runId/paypal-batches */
type BatchState = 'intent' | 'posted' | 'submitted' | 'completed' | 'failed' | 'denied' | 'released' | 'reconcile_required';
interface PaypalBatch {
  batchId: string;
  environment: PaypalEnvironment;
  currency: string;
  itemCount: number;
  total: string;
  state: BatchState;
  payoutBatchId: string | null;
  /** Balances PayPal can't send, sent in `currency` at a quoted rate. */
  conversion?: { sourceCurrency: string; sourceTotal: string; rate: string; rateDate: string } | null;
  summary: { paid: number; released: number; unclaimed: number; processing: number };
  /** A finished sandbox batch: what PayPal's sandbox did with test money. */
  rehearsal?: { paid: number; unclaimed: number; failed: number } | null;
  lastError: string | null;
  createdAt: string;
  lastSyncedAt: string | null;
}

/** POST /payouts/runs/:runId/paypal-batches/quote */
interface ConversionQuote {
  quoteId: string;
  /** The app the quote is bound to; a send after a switch is refused. */
  environment: PaypalEnvironment;
  currency: string;
  sendAs: string;
  rate: string;
  rateDate: string;
  expiresAt: string;
  count: number;
  sourceTotal: string;
  sentTotal: string;
  leftOut: Array<{ payoutId: string; partnerName: string; amount: string; sentAmount: string; reason: 'over_paypal_limit' | 'below_minimum' }>;
}

/** Why a converted send didn't go, in words. */
const QUOTE_ERRORS: Record<string, string> = {
  quote_expired: 'The exchange-rate quote expired (they last 15 minutes). Press the button again for a fresh one.',
  quote_changed: 'These payouts, or the PayPal app sending them, changed since the quote. Press the button again for a fresh quote.',
  conversion_not_enabled: 'Paying INR balances in USD is turned off in Settings.',
  fx_unavailable: 'The European Central Bank reference rates can’t be read right now, so nothing was sent. Try again shortly.',
};

function quoteError(err: unknown): unknown {
  return err instanceof ApiError && typeof (err.detail as { error?: string } | undefined)?.error === 'string'
    ? (QUOTE_ERRORS[(err.detail as { error: string }).error] ?? err)
    : err;
}

/** What the brand confirms before a converted batch goes. */
function conversionAsk(q: ConversionQuote): string {
  const what = `${q.count === 1 ? '1 payout' : `${q.count.toLocaleString()} payouts`} totalling ${money(q.sourceTotal, q.currency)} as ${money(q.sentTotal, q.sendAs)}`;
  const lines = [
    q.environment === 'sandbox'
      ? `Test ${what} with your PayPal sandbox app? PayPal’s sandbox moves test money only: nothing is marked paid, and the payouts come back to send when it’s done.`
      : `Send ${what} from your live PayPal account now? PayPal moves the money as soon as it accepts the batch.`,
    `Rate: ${rateLabel(q.rate, q.currency, q.sendAs)}, the European Central Bank reference rate of ${rateDateLabel(q.rateDate)}. Each payout is converted and rounded on its own.`,
    withdrawalNote(q.sendAs, q.currency, 'brand'),
  ];
  const over = q.leftOut.filter((l) => l.reason === 'over_paypal_limit').length;
  const tiny = q.leftOut.length - over;
  if (over > 0) lines.push(`${over === 1 ? '1 payout is' : `${over} payouts are`} over PayPal’s per-payment limit in ${q.sendAs} and stay out of this batch. Pay them another way.`);
  if (tiny > 0) lines.push(`${tiny === 1 ? '1 payout is' : `${tiny} payouts are`} under a cent in ${q.sendAs} and stay out.`);
  lines.push(`This rate holds until ${new Date(q.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
  return lines.join('\n\n');
}

/** POST /payouts/runs/:runId/exports */
interface ExportFile {
  export: { exportId: string; provider: Provider; currency: string; count: number; total: string };
  filename: string;
  csv: string;
}

const PROVIDER: Record<Provider, string> = { paypal: 'PayPal', wise: 'Wise' };

const EXCLUSION: Record<Exclusion, string> = {
  no_payout_details: 'No payout details yet.',
  details_unreadable: 'Saved details can’t be read. Ask the partner to enter them again.',
  pay_individually: 'Pay this one yourself.',
  currency_not_supported: 'No file can send this currency. Pay it another way.',
  details_incomplete: 'Wise needs the account holder’s address for this payout. Ask the partner to add it.',
  over_paypal_limit: 'More than PayPal sends in one payment. Pay it another way.',
  country_not_supported: 'Country OpenPartner doesn’t serve. Don’t pay.',
  screening_confirmed: 'Confirmed sanctions-list match. Don’t pay.',
};

const BATCH_STATE: Record<BatchState, string> = {
  intent: 'Waiting to send',
  posted: 'Sent, waiting for PayPal to confirm',
  submitted: 'PayPal is paying',
  completed: 'Done',
  failed: 'Not sent',
  denied: 'Refused by PayPal',
  released: 'Released',
  reconcile_required: 'Check this batch in PayPal',
};

const ITEM_STATUS: Record<string, string> = {
  PENDING: 'PayPal is paying',
  ONHOLD: 'On hold at PayPal',
  UNCLAIMED: 'Unclaimed: PayPal emailed the partner to claim it',
  SUCCESS: 'Paid',
};

/** Details changed this recently before a payout get a second look. */
const RECENT_CHANGE_MS = 7 * 24 * 60 * 60 * 1000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The manual rail's payouts to send (docs/manual-payout-files.md,
 * docs/paypal-payouts.md): pick a run, then either make PayPal and Wise
 * files for your own accounts and mark each as sent once its batch has gone
 * out, or pay PayPal partners in one click through your own PayPal app. A
 * file's or batch's payouts are fixed when it's made.
 */
export function ManualPayoutFiles() {
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);

  const runs = useInfiniteQuery({
    queryKey: ['manual-payout-runs'],
    queryFn: ({ pageParam }) =>
      api<{ runs: RunSummary[]; nextCursor: string | null }>(`/payouts/runs${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const list = useMemo(() => runs.data?.pages.flatMap((p) => p.runs) ?? [], [runs.data]);
  const connections = usePaypalConnections();
  const activePaypal = connections.data?.connections.find((c) => c.active) ?? null;

  // Default to the newest run, and move off one that's fully confirmed.
  useEffect(() => {
    if (list.length > 0 && !list.some((r) => r.runId === runId)) setRunId(list[0]!.runId);
  }, [list, runId]);

  const run = useQuery({
    queryKey: ['manual-payout-run', runId],
    queryFn: () => api<ManualRun>(`/payouts/runs/${runId}`),
    enabled: !!runId,
  });

  const payouts = useInfiniteQuery({
    queryKey: ['manual-payout-run-payouts', runId],
    queryFn: ({ pageParam }) =>
      api<{ payouts: RunPayout[]; nextCursor: string | null }>(
        `/payouts/runs/${runId}/payouts${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!runId,
  });

  const batches = useQuery({
    queryKey: ['manual-payout-run-paypal', runId],
    queryFn: () => api<{ batches: PaypalBatch[] }>(`/payouts/runs/${runId}/paypal-batches`),
    enabled: !!runId,
    // PayPal pays in the background: keep an eye on batches in flight.
    refetchInterval: (q) =>
      (q.state.data?.batches ?? []).some((b) => b.state === 'intent' || b.state === 'posted' || (b.state === 'submitted' && b.summary.processing > 0)) ? 15_000 : false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['manual-payout-runs'] });
    qc.invalidateQueries({ queryKey: ['manual-payout-run', runId] });
    qc.invalidateQueries({ queryKey: ['manual-payout-run-payouts', runId] });
    qc.invalidateQueries({ queryKey: ['manual-payout-run-paypal', runId] });
    qc.invalidateQueries({ queryKey: ['paypal-connections'] });
    qc.invalidateQueries({ queryKey: ['payouts'] });
  };

  const makeFile = useMutation({
    mutationFn: (g: { provider: Provider; currency: string }) =>
      api<ExportFile>(`/payouts/runs/${runId}/exports`, { method: 'POST', body: g }),
    onSuccess: (file) => {
      saveBlob(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }), file.filename);
      refresh();
    },
  });

  const payWithPaypal = useMutation({
    mutationFn: (currency: string) => api<{ batch: PaypalBatch }>(`/payouts/runs/${runId}/paypal-batches`, { method: 'POST', body: { currency } }),
    onSettled: refresh,
  });

  // Balances PayPal can't send (INR): quote the rate, show it, then send
  // at exactly that rate.
  const payConverted = useMutation({
    mutationFn: async (g: { currency: string; sendAs: string }) => {
      const { quote } = await api<{ quote: ConversionQuote }>(`/payouts/runs/${runId}/paypal-batches/quote`, {
        method: 'POST',
        body: { currency: g.currency, sendAs: g.sendAs },
      });
      if (!window.confirm(conversionAsk(quote))) return null;
      return api<{ batch: PaypalBatch }>(`/payouts/runs/${runId}/paypal-batches`, {
        method: 'POST',
        body: { currency: g.currency, sendAs: g.sendAs, quoteId: quote.quoteId },
      });
    },
    onSettled: refresh,
  });

  const syncBatch = useMutation({
    mutationFn: (batchId: string) => api<{ batch: PaypalBatch }>(`/payouts/paypal-batches/${batchId}/sync`, { method: 'POST' }),
    onSettled: refresh,
  });

  const resolveBatch = useMutation({
    mutationFn: (r: { batchId: string; body: { action: 'retry' | 'release' } | { action: 'link'; payoutBatchId: string } }) =>
      api<{ batch: PaypalBatch }>(`/payouts/paypal-batches/${r.batchId}/resolve`, { method: 'POST', body: r.body }),
    onSettled: refresh,
  });

  const cancelUnclaimed = useMutation({
    mutationFn: (payoutId: string) => api(`/payouts/${payoutId}/paypal-cancel`, { method: 'POST' }),
    onSettled: refresh,
  });

  const downloadAgain = useMutation({
    mutationFn: (e: ManualRun['exports'][number]) =>
      apiDownload(`/payouts/exports/${e.exportId}.csv`, `${e.provider}-payouts-${e.exportId}-${e.currency}.csv`),
  });

  const confirmFile = useMutation({
    mutationFn: (exportId: string) =>
      api<{ confirmed: unknown[]; notConfirmable: unknown[] }>(`/payouts/exports/${exportId}/confirm`, { method: 'POST' }),
    onSuccess: refresh,
  });

  const discardFile = useMutation({
    mutationFn: (exportId: string) => api<{ released: number }>(`/payouts/exports/${exportId}/discard`, { method: 'POST' }),
    onSuccess: refresh,
  });

  const confirmOne = useMutation({
    mutationFn: (payoutId: string) =>
      api<{ confirmed: unknown[]; notConfirmable: unknown[] }>('/payouts/confirm', { method: 'POST', body: { payoutIds: [payoutId] } }),
    onSuccess: refresh,
  });

  const busy =
    makeFile.isPending ||
    payWithPaypal.isPending ||
    payConverted.isPending ||
    syncBatch.isPending ||
    resolveBatch.isPending ||
    cancelUnclaimed.isPending ||
    confirmFile.isPending ||
    discardFile.isPending ||
    confirmOne.isPending;
  const rows = payouts.data?.pages.flatMap((p) => p.payouts) ?? [];
  const paypalBatches = batches.data?.batches ?? [];

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <FileSpreadsheet size={18} style={{ color: theme.accentText }} />
        <div style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>Manual payouts to send</div>
        {(list.length > 1 || runs.hasNextPage) && (
          <Select
            value={runId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__more') void runs.fetchNextPage();
              else setRunId(e.target.value);
            }}
            style={{ maxWidth: 340 }}
          >
            {list.map((r) => (
              <option key={r.runId} value={r.runId}>
                {formatDate(r.createdAt)} · {r.pendingCount} to send · {r.pendingTotals.map((t) => money(t.amount, t.currency)).join(' + ')}
              </option>
            ))}
            {runs.hasNextPage && <option value="__more">Older runs…</option>}
          </Select>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: theme.textMuted, marginBottom: 14, lineHeight: 1.5, maxWidth: 760 }}>
        Partners you pay yourself (the manual rail) land here after each payout run. Make a file and upload it to your own
        PayPal (Send Money → Make a Mass Payment) or Wise (Payments → Batch) account, then mark it as sent once the batch
        has gone out.{' '}
        {activePaypal?.environment === 'live' ? (
          <>
            Or pay PayPal partners in one click: <strong>Pay with PayPal</strong> sends the batch from your PayPal app and
            marks each payout paid as PayPal pays it.
          </>
        ) : activePaypal ? (
          <>
            Your PayPal <strong>sandbox</strong> app is the one connected for sending, so PayPal batches are tests with
            test money: nothing is marked paid. Switch to your live app in Settings to pay for real.
          </>
        ) : (
          <>
            To pay PayPal partners in one click instead, <TenantLink to="/admin/settings">connect your PayPal app</TenantLink> in
            Settings.
          </>
        )}{' '}
        Either way the money goes straight from you to your partners.
      </div>
      <ErrorBanner
        error={
          runs.error ??
          run.error ??
          payouts.error ??
          batches.error ??
          makeFile.error ??
          payWithPaypal.error ??
          quoteError(payConverted.error) ??
          syncBatch.error ??
          resolveBatch.error ??
          cancelUnclaimed.error ??
          downloadAgain.error ??
          confirmFile.error ??
          discardFile.error ??
          confirmOne.error
        }
      />

      {runs.isLoading ? (
        <div style={{ fontSize: 13, color: theme.textMuted }}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ fontSize: 13, color: theme.textMuted, padding: '10px 12px', background: theme.bg, borderRadius: theme.radiusSm }}>
          Nothing to send right now. When a payout run pays a partner on the manual rail (no Stripe Connect account, or the
          rail set to manual in Settings), their payout shows up here, ready for a file or for Pay with PayPal.
        </div>
      ) : (
        run.data && (
          <>
            {paypalBatches.length > 0 && (
              <Section title="Sent with PayPal">
                {paypalBatches.map((b) => (
                  <BatchRow
                    key={b.batchId}
                    b={b}
                    busy={busy}
                    onSync={() => syncBatch.mutate(b.batchId)}
                    onResolve={(body) => resolveBatch.mutate({ batchId: b.batchId, body })}
                  />
                ))}
              </Section>
            )}

            {run.data.exports.length > 0 && (
              <Section title="Files made">
                {run.data.exports.map((e) => (
                  <Row key={e.exportId}>
                    <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>{PROVIDER[e.provider]}</span>
                      <span style={{ color: theme.textMuted }}>
                        {' '}
                        · {e.currency} · {plural(e.pendingCount, 'payout')} to confirm · {money(e.pendingTotal, e.currency)} · made{' '}
                        {formatDate(e.createdAt, { relative: true })}
                      </span>
                      {e.changedCount > 0 && (
                        <Warn>
                          {plural(e.changedCount, 'partner')} changed their payout details since this file was made. A new
                          download carries the new details or leaves them out.
                        </Warn>
                      )}
                      {e.doNotPayCount > 0 && (
                        <Warn danger>
                          {plural(e.doNotPayCount, 'payout')} in this file must not be paid now, and won’t be marked as sent.
                        </Warn>
                      )}
                    </div>
                    <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => downloadAgain.mutate(e)} disabled={busy}>
                      Download again
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={13} />}
                      onClick={() => {
                        if (window.confirm('Discard this file? Only do this if you never uploaded it. Its payouts can then go into a new file.')) {
                          discardFile.mutate(e.exportId);
                        }
                      }}
                      disabled={busy}
                    >
                      Discard
                    </Button>
                    <Button
                      size="sm"
                      icon={<CheckCheck size={13} />}
                      onClick={() => {
                        const what = e.pendingCount === 1 ? `this ${PROVIDER[e.provider]} file’s payout` : `this ${PROVIDER[e.provider]} file’s ${e.pendingCount} payouts`;
                        if (window.confirm(`Mark ${what} as sent? Only do this once the batch has gone out.`)) confirmFile.mutate(e.exportId);
                      }}
                      disabled={busy}
                    >
                      Mark sent
                    </Button>
                  </Row>
                ))}
              </Section>
            )}

            {run.data.ready.length > 0 && (
              <Section title="Ready to send">
                {run.data.ready.map((g) =>
                  g.sendAs ? (
                    <Row key={`${g.provider}:${g.currency}:${g.sendAs}`}>
                      <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>{PROVIDER[g.provider]}</span>
                        <span style={{ color: theme.textMuted }}>
                          {' '}
                          · {g.currency} → {g.sendAs} · {plural(g.count, 'payout')} · {money(g.total, g.currency)}
                        </span>
                        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>
                          PayPal can’t send {g.currency}. These go out in {g.sendAs} at the European Central Bank rate, which you see
                          before anything is sent. No file can do this.
                        </div>
                      </div>
                      {activePaypal ? (
                        <Button
                          size="sm"
                          icon={<Send size={13} />}
                          onClick={() => payConverted.mutate({ currency: g.currency, sendAs: g.sendAs! })}
                          disabled={busy}
                        >
                          {payConverted.isPending
                            ? 'Getting the rate…'
                            : activePaypal.environment === 'sandbox'
                              ? `Test with PayPal sandbox in ${g.sendAs}`
                              : `Pay with PayPal in ${g.sendAs}`}
                        </Button>
                      ) : (
                        <span style={{ fontSize: 12.5, color: theme.textMuted }}>
                          <TenantLink to="/admin/settings">Connect your PayPal app</TenantLink> to send these.
                        </span>
                      )}
                    </Row>
                  ) : (
                    <Row key={`${g.provider}:${g.currency}`}>
                      <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>{PROVIDER[g.provider]}</span>
                        <span style={{ color: theme.textMuted }}>
                          {' '}
                          · {g.currency} · {plural(g.count, 'payout')} · {money(g.total, g.currency)}
                        </span>
                      </div>
                      <Button size="sm" variant="secondary" icon={<FilePlus2 size={13} />} onClick={() => makeFile.mutate({ provider: g.provider, currency: g.currency })} disabled={busy}>
                        Make file
                      </Button>
                      {g.provider === 'paypal' && activePaypal && (
                        <Button
                          size="sm"
                          icon={<Send size={13} />}
                          onClick={() => {
                            const n = Math.min(g.count, 5000);
                            const what = n === g.count ? `${plural(n, 'payout')} totalling ${money(g.total, g.currency)}` : `the first ${n.toLocaleString()} of these payouts`;
                            const ask =
                              activePaypal.environment === 'sandbox'
                                ? `Test ${what} with your PayPal sandbox app? PayPal’s sandbox moves test money only: nothing is marked paid, and the payouts come back to send when it’s done.`
                                : `Send ${what} from your live PayPal account now? PayPal moves the money as soon as it accepts the batch.`;
                            if (window.confirm(ask)) payWithPaypal.mutate(g.currency);
                          }}
                          disabled={busy}
                        >
                          {payWithPaypal.isPending ? 'Sending…' : activePaypal.environment === 'sandbox' ? 'Test with PayPal sandbox' : 'Pay with PayPal'}
                        </Button>
                      )}
                    </Row>
                  ),
                )}
              </Section>
            )}

            {rows.length === 0 && !payouts.isLoading ? (
              <div style={{ fontSize: 13, color: theme.textMuted }}>Every payout in this run is marked as sent.</div>
            ) : (
              <>
                <Table
                  columns={['Partner', { label: 'Amount', align: 'right' }, 'Pays to', 'File']}
                  rows={rows.map((p) => [
                    <div>
                      <div style={{ fontWeight: 500 }}>{p.partnerName}</div>
                      <div style={{ fontSize: 12, color: theme.textDim }}>{p.partnerEmail}</div>
                    </div>,
                    <div>
                      <span style={{ fontWeight: 500 }}>{money(p.amount, p.currency)}</span>
                      {p.export?.conversion && (
                        <div style={{ fontSize: 12, color: theme.textMuted }} title={rateLabel(p.export.conversion.rate, p.export.conversion.sourceCurrency, p.export.conversion.sentCurrency)}>
                          sent as {money(p.export.conversion.sentAmount, p.export.conversion.sentCurrency)}
                        </div>
                      )}
                    </div>,
                    <div style={{ fontSize: 13 }}>
                      <div>{p.destination?.summary ?? <span style={{ color: theme.textDim }}>—</span>}</div>
                      <Notes p={p} />
                    </div>,
                    <FileCell
                      p={p}
                      busy={busy}
                      onConfirm={() => {
                        if (window.confirm(`Mark the payout to ${p.partnerName} as sent? Only do this once the money has gone out.`)) {
                          confirmOne.mutate(p.payoutId);
                        }
                      }}
                      onCancelUnclaimed={() => {
                        if (window.confirm(`Cancel the unclaimed PayPal payment to ${p.partnerName}? PayPal returns the money to your balance, and the payout goes back to “to send”.`)) {
                          cancelUnclaimed.mutate(p.payoutId);
                        }
                      }}
                    />,
                  ])}
                />
                {payouts.hasNextPage && (
                  <div style={{ marginTop: 10 }}>
                    <Button size="sm" variant="secondary" onClick={() => void payouts.fetchNextPage()} disabled={payouts.isFetchingNextPage}>
                      {payouts.isFetchingNextPage ? 'Loading…' : 'Show more'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )
      )}
    </Card>
  );
}

function BatchRow({
  b,
  busy,
  onSync,
  onResolve,
}: {
  b: PaypalBatch;
  busy: boolean;
  onSync: () => void;
  onResolve: (body: { action: 'retry' | 'release' } | { action: 'link'; payoutBatchId: string }) => void;
}) {
  const s = b.summary;
  const parts = [
    s.paid > 0 && `${s.paid} paid`,
    s.processing > 0 && `${s.processing} processing`,
    s.unclaimed > 0 && `${s.unclaimed} unclaimed`,
    s.released > 0 && `${s.released} back to send`,
  ].filter(Boolean);
  const open = b.state === 'intent' || b.state === 'posted' || b.state === 'submitted';
  return (
    <Row>
      <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
        <span style={{ fontWeight: 600 }}>PayPal{b.environment === 'sandbox' ? ' sandbox' : ''}</span>
        <span style={{ color: theme.textMuted }}>
          {' '}
          · {b.currency} · {plural(b.itemCount, 'payout')} · {money(b.total, b.currency)}
          {b.conversion && ` (${money(b.conversion.sourceTotal, b.conversion.sourceCurrency)} at ${rateLabel(b.conversion.rate, b.conversion.sourceCurrency, b.currency)}, ECB ${rateDateLabel(b.conversion.rateDate)})`} · sent{' '}
          {formatDate(b.createdAt, { relative: true })}
        </span>
        <div style={{ fontSize: 12.5, marginTop: 2, color: b.state === 'reconcile_required' || b.state === 'failed' || b.state === 'denied' ? theme.danger : theme.textMuted }}>
          {b.state === 'submitted' && s.processing === 0 && s.unclaimed > 0 ? 'Waiting for partners to claim their payments' : BATCH_STATE[b.state]}
          {parts.length > 0 && ` · ${parts.join(' · ')}`}
          {b.payoutBatchId && (
            <span style={{ color: theme.textDim }}>
              {' '}
              · PayPal batch <code>{b.payoutBatchId}</code>
            </span>
          )}
        </div>
        {b.rehearsal && (
          <Warn>
            Sandbox test: {b.rehearsal.paid} paid, {b.rehearsal.unclaimed} unclaimed, {b.rehearsal.failed} failed, with
            PayPal’s test money. Nothing was marked paid; these payouts are back to send.
          </Warn>
        )}
        {b.environment === 'sandbox' && open && (
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>
            A sandbox test: no payout is marked paid, and they all go back to send when PayPal is done.
          </div>
        )}
        {b.lastError && <Warn danger={b.state !== 'posted' && b.state !== 'submitted'}>{b.lastError}</Warn>}
        {b.state === 'reconcile_required' && (
          <Warn>
            Look in your PayPal account (Activity) for a payout batch with ID <code>{b.batchId}</code>. If it’s there, link it
            so OpenPartner follows it. If it never went out, release the payouts so you can send them again.
          </Warn>
        )}
      </div>
      {open && (
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onSync} disabled={busy}>
          Check status
        </Button>
      )}
      {b.state === 'reconcile_required' && (
        <>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const id = window.prompt('The PayPal payout batch ID shown in your PayPal account:')?.trim();
              if (id) onResolve({ action: 'link', payoutBatchId: id });
            }}
            disabled={busy}
          >
            Link PayPal batch
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onResolve({ action: 'retry' })} disabled={busy}>
            Try again
          </Button>
        </>
      )}
      {(b.state === 'reconcile_required' || b.state === 'intent' || (b.environment === 'sandbox' && open)) && (
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            const ask =
              b.environment === 'sandbox'
                ? 'Release these payouts from the sandbox test now? They go back to “to send”.'
                : 'Release these payouts? Only do this if you checked your PayPal account and this batch never went out. They go back to “to send”.';
            if (window.confirm(ask)) onResolve({ action: 'release' });
          }}
          disabled={busy}
        >
          Release
        </Button>
      )}
    </Row>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '10px 12px',
        background: theme.bg,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      {children}
    </div>
  );
}

function Warn({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  const color = danger ? theme.danger : theme.warn;
  return (
    <div style={{ fontSize: 12, marginTop: 4, color, background: alpha(color, 0.08), padding: '2px 6px', borderRadius: 4 }}>{children}</div>
  );
}

function FileCell({
  p,
  busy,
  onConfirm,
  onCancelUnclaimed,
}: {
  p: RunPayout;
  busy: boolean;
  onConfirm: () => void;
  onCancelUnclaimed: () => void;
}) {
  if (p.export?.via === 'api') {
    const status = p.export.paypal?.status;
    return (
      <div style={{ fontSize: 13, maxWidth: 240 }}>
        Sent with PayPal · {formatDate(p.export.createdAt, { relative: true })}
        <div style={{ fontSize: 12, color: status === 'UNCLAIMED' ? theme.warn : theme.textMuted }}>
          {status ? (ITEM_STATUS[status] ?? status) : 'Waiting for PayPal'}
          {p.export.paypal?.error && ` (${p.export.paypal.error})`}
        </div>
        {status === 'UNCLAIMED' && (
          <Button size="sm" variant="ghost" style={{ marginTop: 4, marginLeft: -10 }} onClick={onCancelUnclaimed} disabled={busy}>
            Cancel and get it back
          </Button>
        )}
      </div>
    );
  }
  if (p.export) {
    return (
      <div style={{ fontSize: 13 }}>
        {PROVIDER[p.export.provider]} file · {formatDate(p.export.createdAt, { relative: true })}
        {p.export.reference && (
          <div style={{ fontSize: 11.5, color: theme.textDim, wordBreak: 'break-all' }}>
            ref <code>{p.export.reference}</code>
          </div>
        )}
      </div>
    );
  }
  if (p.ready && p.sendAs) return <div style={{ fontSize: 13, color: theme.textMuted }}>Ready for {PROVIDER[p.ready]}, sent in {p.sendAs}</div>;
  if (p.ready) return <div style={{ fontSize: 13, color: theme.textMuted }}>Ready for {PROVIDER[p.ready]}</div>;
  return (
    <div style={{ fontSize: 12.5, maxWidth: 220 }}>
      <div style={{ color: p.doNotPay ? theme.danger : theme.textMuted }}>{p.excluded ? EXCLUSION[p.excluded] : '—'}</div>
      {!p.doNotPay && (
        <Button size="sm" variant="ghost" style={{ marginTop: 4, marginLeft: -10 }} onClick={onConfirm} disabled={busy}>
          Mark sent
        </Button>
      )}
    </div>
  );
}

/** Warnings worth reading before sending: do not pay, compliance, a change
 *  of destination. */
function Notes({ p }: { p: RunPayout }) {
  const notes: Array<{ text: string; danger?: boolean }> = [];
  if (p.doNotPay && p.export) notes.push({ text: `${EXCLUSION[p.doNotPay]} It won’t be marked as sent with its file.`, danger: true });
  else if (p.complianceWarning && !p.doNotPay) notes.push({ text: `${HOLD_REASON[p.complianceWarning]} Check before you send it.` });
  if (p.export?.destinationChanged) {
    notes.push({ text: 'Payout details changed since this file was made.' });
  } else if (!p.export && p.destination && Date.now() - new Date(p.destination.updatedAt).getTime() < RECENT_CHANGE_MS) {
    const by = p.destination.updatedBy === 'partner' ? 'by the partner' : p.destination.updatedBy === 'admin' ? 'by an admin' : 'through the API';
    notes.push({ text: `Details changed ${formatDate(p.destination.updatedAt, { relative: true })} ${by}.` });
  }
  return (
    <>
      {notes.map((n) => (
        <Warn key={n.text} danger={n.danger}>
          {n.text}
        </Warn>
      ))}
    </>
  );
}
