import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Download, FileSpreadsheet } from 'lucide-react';
import { api, apiDownload } from '../api.js';
import { alpha, theme } from '../theme.js';
import { Button, Card, ErrorBanner, Select, Table, formatDate, money } from '../ui.js';
import { HOLD_REASON, type HoldReason } from './payout-holds.js';

type Provider = 'paypal' | 'wise';
type Exclusion =
  | 'no_payout_details'
  | 'details_unreadable'
  | 'pay_individually'
  | 'currency_not_supported'
  | 'country_not_supported'
  | 'screening_confirmed';

/** GET /payouts/runs */
interface RunSummary {
  runId: string;
  createdAt: string;
  payoutCount: number;
  pendingCount: number;
  pendingTotals: Array<{ currency: string; amount: string }>;
}

/** GET /payouts/runs/:runId */
interface ManualRun {
  runId: string;
  createdAt: string;
  payouts: Array<{
    payoutId: string;
    partnerId: string;
    partnerName: string;
    partnerEmail: string;
    amount: string;
    currency: string;
    status: string;
    destination: {
      method: 'paypal' | 'bank' | 'upi' | 'other';
      country: string | null;
      summary: string | null;
      updatedAt: string;
      updatedBy: 'partner' | 'admin' | 'api';
    } | null;
    file: { provider: Provider; currency: string; part: number; reference: string | null } | null;
    excluded: Exclusion | null;
    complianceWarning: HoldReason | null;
    lastExport: { provider: Provider; at: string } | null;
  }>;
  files: Array<{ provider: Provider; currency: string; part: number; count: number; total: string }>;
}

const PROVIDER: Record<Provider, string> = { paypal: 'PayPal', wise: 'Wise' };

const EXCLUSION: Record<Exclusion, string> = {
  no_payout_details: 'No payout details yet.',
  details_unreadable: 'Saved details can’t be read. Ask the partner to enter them again.',
  pay_individually: 'Pay this one yourself.',
  currency_not_supported: 'PayPal can’t send this currency. Pay it another way.',
  country_not_supported: 'Country OpenPartner doesn’t serve. In no file.',
  screening_confirmed: 'Confirmed sanctions-list match. Don’t pay.',
};

/** Reasons a payout must not be paid at all, so it has no "Mark sent". */
const DO_NOT_PAY: ReadonlySet<Exclusion> = new Set(['country_not_supported', 'screening_confirmed']);

/** Details changed this recently before a payout get a second look. */
const RECENT_CHANGE_MS = 7 * 24 * 60 * 60 * 1000;

const fileKey = (f: { provider: Provider; currency: string; part: number }) => `${f.provider}:${f.currency}:${f.part}`;

/**
 * The manual rail's batch files (docs/manual-payout-files.md): pick a run,
 * download its PayPal and Wise files for your own accounts, then mark what
 * went out as sent.
 */
export function ManualPayoutFiles() {
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['manual-payout-runs'],
    queryFn: () => api<{ runs: RunSummary[] }>('/payouts/runs'),
  });
  const list = useMemo(() => runs.data?.runs ?? [], [runs.data]);

  // Default to the newest run, and move off one that's fully confirmed.
  useEffect(() => {
    if (list.length > 0 && !list.some((r) => r.runId === runId)) setRunId(list[0]!.runId);
  }, [list, runId]);

  const run = useQuery({
    queryKey: ['manual-payout-run', runId],
    queryFn: () => api<ManualRun>(`/payouts/runs/${runId}`),
    enabled: !!runId,
  });

  const download = useMutation({
    mutationFn: (f: { provider: Provider; currency: string; part: number; count: number }) =>
      apiDownload(
        `/payouts/runs/${runId}/${f.provider}.csv?currency=${f.currency}&part=${f.part}`,
        `${f.provider}-payouts-${runId}-${f.currency}${f.part > 1 ? `-part${f.part}` : ''}.csv`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['manual-payout-run', runId] }),
  });

  const confirm = useMutation({
    mutationFn: (payoutIds: string[]) =>
      api<{ confirmed: unknown[]; notConfirmable: unknown[] }>('/payouts/confirm', { method: 'POST', body: { payoutIds } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['manual-payout-runs'] });
      qc.invalidateQueries({ queryKey: ['manual-payout-run', runId] });
      qc.invalidateQueries({ queryKey: ['payouts'] });
    },
  });

  if (runs.isLoading || list.length === 0) return null;

  const pending = (run.data?.payouts ?? []).filter((p) => p.status === 'pending');
  const inFile = (f: ManualRun['files'][number]) => pending.filter((p) => p.file && fileKey(p.file) === fileKey(f));

  const markSent = (ids: string[], what: string) => {
    if (ids.length === 0) return;
    if (!window.confirm(`Mark ${what} as sent? Only do this once the money has gone out.`)) return;
    confirm.mutate(ids);
  };

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <FileSpreadsheet size={18} style={{ color: theme.accentText }} />
        <div style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>Manual payouts to send</div>
        {list.length > 1 && (
          <Select value={runId ?? ''} onChange={(e) => setRunId(e.target.value)} style={{ maxWidth: 320 }}>
            {list.map((r) => (
              <option key={r.runId} value={r.runId}>
                {formatDate(r.createdAt)} · {r.pendingCount} to send · {r.pendingTotals.map((t) => money(t.amount, t.currency)).join(' + ')}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: theme.textMuted, marginBottom: 14, lineHeight: 1.5, maxWidth: 760 }}>
        Download a file and upload it to your own PayPal (Send Money → Make a Mass Payment) or Wise (Payments → Batch)
        account. The money goes straight from you to your partners. Once a batch has gone out, mark its payouts as sent.
      </div>
      <ErrorBanner error={runs.error ?? run.error ?? download.error ?? confirm.error} />

      {run.data && (
        <>
          {run.data.files.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {run.data.files.map((f) => {
                const rows = inFile(f);
                const downloaded = rows.length > 0 && rows.every((p) => p.lastExport?.provider === f.provider);
                return (
                  <div
                    key={fileKey(f)}
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
                    <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>{PROVIDER[f.provider]}</span>
                      <span style={{ color: theme.textMuted }}>
                        {' '}
                        · {f.currency}
                        {f.part > 1 || run.data!.files.some((o) => o !== f && o.provider === f.provider && o.currency === f.currency) ? ` · part ${f.part}` : ''} ·{' '}
                        {f.count} payout{f.count === 1 ? '' : 's'} · {money(f.total, f.currency)}
                      </span>
                      {downloaded && <span style={{ color: theme.textDim }}> · downloaded</span>}
                    </div>
                    <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={() => download.mutate(f)} disabled={download.isPending}>
                      Download
                    </Button>
                    <Button
                      size="sm"
                      icon={<CheckCheck size={13} />}
                      onClick={() =>
                        markSent(
                          rows.map((p) => p.payoutId),
                          rows.length === 1 ? `this ${PROVIDER[f.provider]} payout` : `these ${rows.length} ${PROVIDER[f.provider]} payouts`,
                        )
                      }
                      disabled={confirm.isPending}
                    >
                      Mark sent
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {pending.length === 0 ? (
            <div style={{ fontSize: 13, color: theme.textMuted }}>Every payout in this run is marked as sent.</div>
          ) : (
            <Table
              columns={['Partner', { label: 'Amount', align: 'right' }, 'Pays to', 'File']}
              rows={pending.map((p) => [
                <div>
                  <div style={{ fontWeight: 500 }}>{p.partnerName}</div>
                  <div style={{ fontSize: 12, color: theme.textDim }}>{p.partnerEmail}</div>
                </div>,
                <span style={{ fontWeight: 500 }}>{money(p.amount, p.currency)}</span>,
                <div style={{ fontSize: 13 }}>
                  <div>{p.destination?.summary ?? <span style={{ color: theme.textDim }}>—</span>}</div>
                  <Notes p={p} />
                </div>,
                p.file ? (
                  <div style={{ fontSize: 13 }}>
                    {PROVIDER[p.file.provider]} {p.file.currency}
                    {p.file.reference && (
                      <div style={{ fontSize: 11.5, color: theme.textDim, wordBreak: 'break-all' }}>
                        ref <code>{p.file.reference}</code>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, maxWidth: 220 }}>
                    <div style={{ color: p.excluded && DO_NOT_PAY.has(p.excluded) ? theme.danger : theme.textMuted }}>
                      {p.excluded ? EXCLUSION[p.excluded] : '—'}
                    </div>
                    {!(p.excluded && DO_NOT_PAY.has(p.excluded)) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        style={{ marginTop: 4, marginLeft: -10 }}
                        onClick={() => markSent([p.payoutId], `the payout to ${p.partnerName}`)}
                        disabled={confirm.isPending}
                      >
                        Mark sent
                      </Button>
                    )}
                  </div>
                ),
              ])}
            />
          )}
        </>
      )}
    </Card>
  );
}

/** Warnings worth reading before sending: compliance, a recent change of
 *  destination, a file already downloaded. */
function Notes({ p }: { p: ManualRun['payouts'][number] }) {
  const notes: Array<{ text: string; tone: 'warn' | 'dim' }> = [];
  if (p.complianceWarning && p.excluded == null) notes.push({ text: HOLD_REASON[p.complianceWarning] + ' Check before you send it.', tone: 'warn' });
  if (p.destination && Date.now() - new Date(p.destination.updatedAt).getTime() < RECENT_CHANGE_MS) {
    const by = p.destination.updatedBy === 'partner' ? 'by the partner' : p.destination.updatedBy === 'admin' ? 'by an admin' : 'through the API';
    notes.push({ text: `Details changed ${formatDate(p.destination.updatedAt, { relative: true })} ${by}.`, tone: 'warn' });
  }
  if (p.lastExport) {
    notes.push({ text: `In a ${PROVIDER[p.lastExport.provider]} file downloaded ${formatDate(p.lastExport.at, { relative: true })}.`, tone: 'dim' });
  }
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((n) => (
        <div
          key={n.text}
          style={{
            fontSize: 12,
            marginTop: 3,
            color: n.tone === 'warn' ? theme.warn : theme.textDim,
            ...(n.tone === 'warn' ? { background: alpha(theme.warn, 0.08), padding: '2px 6px', borderRadius: 4 } : {}),
          }}
        >
          {n.text}
        </div>
      ))}
    </>
  );
}
