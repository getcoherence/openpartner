import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift } from 'lucide-react';
import { api } from '../api.js';
import { useDefaultCurrency } from '../lib/useBrand.js';
import { alpha, softText, theme } from '../theme.js';
import {
  Button,
  Card,
  ErrorBanner,
  Input,
  Label,
  SectionHeading,
  Select,
  StatusPill,
  Table,
  Textarea,
  formatDate,
  money,
} from '../ui.js';

/** One row of GET /bonuses. */
interface BonusRow {
  id: string;
  amount: string;
  currency: string;
  source: string;
  note: string | null;
  createdAt: string;
  commission: { id: string; status: string };
}

export interface BonusProgramOption {
  id: string;
  name: string;
}

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Bonus',
  performance_bounty: 'Bounty',
  network: 'Network bounty',
};

/**
 * "Pay a bonus" on the admin partner page (POST /bonuses): a reward with no
 * sale behind it, paid through one commission. Approved now and paid in the
 * next payout run, unless held for the holdback. Below it, the partner's
 * recent bonuses.
 */
export function PartnerBonusSection({
  partnerId,
  partnerName,
  programs,
}: {
  partnerId: string;
  partnerName: string;
  programs: BonusProgramOption[];
}) {
  const [open, setOpen] = useState(false);
  const [paid, setPaid] = useState<string | null>(null);
  const recent = useQuery({
    queryKey: ['partner-bonuses', partnerId],
    queryFn: () => api<{ bonuses: BonusRow[] }>(`/bonuses?partnerId=${encodeURIComponent(partnerId)}&limit=10`),
    enabled: !!partnerId,
  });

  return (
    <>
      <SectionHeading
        actions={
          !open && (
            <Button
              size="sm"
              icon={<Gift size={14} />}
              onClick={() => {
                setPaid(null);
                setOpen(true);
              }}
            >
              Pay a bonus
            </Button>
          )
        }
      >
        Bonuses
      </SectionHeading>
      {paid && (
        <Card style={{ marginBottom: 14, borderColor: alpha(theme.success, 0.333), background: theme.successSoft }}>
          <div role="status" style={{ fontSize: 13, color: theme.success }}>{paid}</div>
        </Card>
      )}
      {open && (
        <PayBonusForm
          partnerId={partnerId}
          partnerName={partnerName}
          programs={programs}
          onClose={() => setOpen(false)}
          onPaid={(message) => {
            setOpen(false);
            setPaid(message);
          }}
        />
      )}
      <ErrorBanner error={recent.error} />
      <Table
        columns={['Bonus', { label: 'Amount', align: 'right' as const }, 'Status', 'Paid out']}
        empty="No bonuses yet."
        rows={(recent.data?.bonuses ?? []).map((b) => [
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, maxWidth: 360, whiteSpace: 'normal' }}>
            <span style={{ overflowWrap: 'anywhere' }}>
              {SOURCE_LABEL[b.source] ?? 'Bonus'}
              {b.note ? `: ${b.note}` : ''}
            </span>
            <span style={{ fontSize: 12, color: theme.textDim }}>{formatDate(b.createdAt, { relative: true })}</span>
          </span>,
          <span style={{ fontWeight: 500 }}>{money(b.amount, b.currency)}</span>,
          <StatusPill status={b.commission.status} />,
          <span style={{ color: theme.textMuted }}>{b.commission.status === 'paid' ? 'Yes' : 'Not yet'}</span>,
        ])}
      />
    </>
  );
}

function PayBonusForm({
  partnerId,
  partnerName,
  programs,
  onClose,
  onPaid,
}: {
  partnerId: string;
  partnerName: string;
  programs: BonusProgramOption[];
  onClose: () => void;
  onPaid: (message: string) => void;
}) {
  const qc = useQueryClient();
  const defaultCurrency = useDefaultCurrency();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [programId, setProgramId] = useState('');
  const [note, setNote] = useState('');
  const [hold, setHold] = useState(false);
  // Minted once per form: a double click or a retry after a dropped
  // response pays once (POST /bonuses is idempotent on externalRef).
  const [externalRef] = useState(() => `portal-${crypto.randomUUID()}`);

  const code = (currency ?? defaultCurrency).trim().toUpperCase();
  const trimmed = amount.trim();
  const value = Number(trimmed);
  const amountOk = /^\d+(\.\d{1,2})?$/.test(trimmed) && value > 0;
  const currencyOk = /^[A-Z]{3}$/.test(code);

  const mut = useMutation({
    mutationFn: () =>
      api<{ bonus: { amount: string; currency: string }; commission: { status: string } }>('/bonuses', {
        method: 'POST',
        body: {
          partnerId,
          amount: value,
          currency: code,
          externalRef,
          ...(programId ? { programId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(hold ? { hold: true } : {}),
        },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['partner-bonuses', partnerId] });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      const what = `${money(res.bonus.amount, res.bonus.currency)} bonus for ${partnerName}`;
      onPaid(
        res.commission.status === 'approved'
          ? `${what}: approved, and paid in the next payout run.`
          : `${what}: held until the holdback ends, then approved.`,
      );
    },
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div role="region" aria-label={`Pay ${partnerName} a bonus`}>
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
          A reward with no sale behind it, like a contest prize or a launch-week thank-you. It shows on their
          Commissions page with your note, and never counts as a sale or toward a tier.
        </div>
        <ErrorBanner error={mut.error} />
        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 14, marginBottom: 14 }}>
          <div>
            <Label>Amount</Label>
            <Input inputMode="decimal" aria-label="Bonus amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50.00" />
            {trimmed !== '' && !amountOk && (
              <div style={{ fontSize: 12, color: theme.danger, marginTop: 6 }}>A positive amount with at most two decimals.</div>
            )}
          </div>
          <div>
            <Label>Currency</Label>
            <Input
              aria-label="Bonus currency"
              value={currency ?? defaultCurrency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <Label>Program (optional)</Label>
          <Select aria-label="Bonus program" value={programId} onChange={(e) => setProgramId(e.target.value)}>
            <option value="">No program</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
            Counts toward that program&rsquo;s earnings, and its holdback applies if you hold the bonus.
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <Label>Note to the partner (optional)</Label>
          <Textarea
            aria-label="Bonus note"
            value={note}
            maxLength={1000}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Top referrer in October. Thank you!"
          />
        </div>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: theme.text, marginBottom: 16 }}>
          <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            Hold it for the holdback first
            <span style={{ color: softText(theme.textMuted), display: 'block' }}>
              Unchecked, it&rsquo;s approved now and goes out in the next payout run.
            </span>
          </span>
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={() => mut.mutate()} disabled={!amountOk || !currencyOk || mut.isPending}>
            {mut.isPending ? 'Paying…' : amountOk && currencyOk ? `Pay ${money(value, code)}` : 'Pay bonus'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
