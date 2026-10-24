import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Download, FilePlus2, FileSpreadsheet, Trash2 } from 'lucide-react';
import { api, apiDownload, saveBlob } from '../api.js';
import { alpha, theme } from '../theme.js';
import { Button, Card, ErrorBanner, Input, Select, Table, formatDate, money } from '../ui.js';
import { HOLD_REASON, type HoldReason } from './payout-holds.js';

type Provider = 'paypal' | 'wise';
type DoNotPay = 'country_not_supported' | 'screening_confirmed';
type Exclusion =
  | 'no_payout_details'
  | 'details_unreadable'
  | 'pay_individually'
  | 'currency_not_supported'
  | 'details_incomplete'
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
  ready: Array<{ provider: Provider; currency: string; count: number; total: string }>;
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
  excluded: Array<{ reason: Exclusion; count: number }>;
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
  export: { exportId: string; provider: Provider; createdAt: string; reference: string | null; destinationChanged: boolean } | null;
  ready: Provider | null;
  excluded: Exclusion | null;
  complianceWarning: HoldReason | null;
  doNotPay: DoNotPay | null;
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
  country_not_supported: 'Country OpenPartner doesn’t serve. Don’t pay.',
  screening_confirmed: 'Confirmed sanctions-list match. Don’t pay.',
};

/** Details changed this recently before a payout get a second look. */
const RECENT_CHANGE_MS = 7 * 24 * 60 * 60 * 1000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The manual rail's batch files (docs/manual-payout-files.md): pick a run,
 * make PayPal and Wise files for your own accounts, then mark each file as
 * sent once its batch has gone out. A file's payouts are fixed when it's
 * made, so "Mark sent" confirms exactly what was in it.
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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['manual-payout-runs'] });
    qc.invalidateQueries({ queryKey: ['manual-payout-run', runId] });
    qc.invalidateQueries({ queryKey: ['manual-payout-run-payouts', runId] });
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

  // One payout sent by hand, with what identifies the payment if the brand
  // has it (printed on the payout's statement).
  const confirmOne = useMutation({
    mutationFn: (v: { payoutId: string; reference: string }) =>
      api<{ payout: unknown }>(`/payouts/${v.payoutId}/confirm`, { method: 'POST', body: v.reference ? { reference: v.reference } : {} }),
    onSuccess: refresh,
  });

  if (runs.isLoading || list.length === 0) return null;

  const busy = makeFile.isPending || confirmFile.isPending || discardFile.isPending || confirmOne.isPending;
  const rows = payouts.data?.pages.flatMap((p) => p.payouts) ?? [];

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
        Make a file and upload it to your own PayPal (Send Money → Make a Mass Payment) or Wise (Payments → Batch)
        account. The money goes straight from you to your partners. A file’s payouts are fixed when you make it: once its
        batch has gone out, mark that file as sent.
      </div>
      <ErrorBanner
        error={runs.error ?? run.error ?? payouts.error ?? makeFile.error ?? downloadAgain.error ?? confirmFile.error ?? discardFile.error ?? confirmOne.error}
      />

      {run.data && (
        <>
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
            <Section title="Ready for a new file">
              {run.data.ready.map((g) => (
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
                </Row>
              ))}
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
                  <span style={{ fontWeight: 500 }}>{money(p.amount, p.currency)}</span>,
                  <div style={{ fontSize: 13 }}>
                    <div>{p.destination?.summary ?? <span style={{ color: theme.textDim }}>—</span>}</div>
                    <Notes p={p} />
                  </div>,
                  // Keyed: a confirmed payout leaves the list, and its open
                  // reference form mustn't pass to the row that moves up.
                  <FileCell key={p.payoutId} p={p} busy={busy} onConfirm={(reference) => confirmOne.mutate({ payoutId: p.payoutId, reference })} />,
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
      )}
    </Card>
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

/** A payout reference is one line of up to this many characters (the API's
 *  confirmPayoutSchema). */
const MAX_REFERENCE = 100;

function FileCell({ p, busy, onConfirm }: { p: RunPayout; busy: boolean; onConfirm: (reference: string) => void }) {
  // Marking a payout sent by hand asks for its payment reference first.
  const [confirming, setConfirming] = useState(false);
  const [reference, setReference] = useState('');
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
  if (p.ready) return <div style={{ fontSize: 13, color: theme.textMuted }}>Ready for {PROVIDER[p.ready]}</div>;
  return (
    <div style={{ fontSize: 12.5, maxWidth: 220 }}>
      <div style={{ color: p.doNotPay ? theme.danger : theme.textMuted }}>{p.excluded ? EXCLUSION[p.excluded] : '—'}</div>
      {!p.doNotPay && !confirming && (
        <Button size="sm" variant="ghost" style={{ marginTop: 4, marginLeft: -10 }} onClick={() => setConfirming(true)} disabled={busy}>
          Mark sent
        </Button>
      )}
      {!p.doNotPay && confirming && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(reference.trim());
          }}
          style={{ marginTop: 6 }}
        >
          <label style={{ display: 'block', color: theme.textMuted }}>
            Payment reference (optional)
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={MAX_REFERENCE}
              autoFocus
              autoComplete="off"
              style={{ fontSize: 13, padding: '6px 8px', marginTop: 4 }}
            />
          </label>
          <div style={{ fontSize: 11.5, color: theme.textDim, margin: '4px 0 6px', lineHeight: 1.4 }}>
            The bank’s UTR, the UPI transaction ID or the cheque number. It’s printed on {p.partnerName}’s statement. Mark
            it sent only once the money has gone out.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button size="sm" type="submit" disabled={busy}>
              Mark sent
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setReference('');
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
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
