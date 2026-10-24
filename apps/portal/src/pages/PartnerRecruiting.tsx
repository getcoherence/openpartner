import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, UserPlus } from 'lucide-react';
import { api, type Principal } from '../api.js';
import { useDebouncedSearch, usePartnerSearch } from '../lib/usePartnerSearch.js';
import { alpha, theme } from '../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, SectionHeading, StatusPill, Table, formatDate, money } from '../ui.js';

/**
 * Two-tier commissions (docs/two-tier-commissions.md): a partner's recruit
 * link and recruits (GET /partners/:id/recruits), for the partner's own
 * Recruit partners page and the admin partner page, where an admin also
 * sets who recruited the partner (PATCH /partners/:id).
 */

export interface PartnerRecruits {
  partnerId: string;
  recruitCode: string | null;
  recruitUrl: string | null;
  signupOpen: boolean;
  programs: Array<{ id: string; name: string; recruiterCommissionPercent: number; recruiterCommissionMonths: number | null }>;
  recruitedBy: { id: string; name: string; recruitedAt: string } | null;
  recruits: Array<{
    id: string;
    name: string;
    recruitedAt: string;
    status: 'active' | 'pending' | 'revoked';
    earned: Record<string, string>;
  }>;
  total: number;
  limit: number;
}

export function recruitsKey(partnerId: string) {
  return ['partner-recruits', partnerId] as const;
}

export function useRecruits(partnerId: string | null | undefined) {
  return useQuery({
    queryKey: recruitsKey(partnerId ?? ''),
    queryFn: () => api<PartnerRecruits>(`/partners/${partnerId}/recruits`),
    enabled: !!partnerId,
    // The lists are always arrays here, whatever an older API answered.
    select: (d) => ({ ...d, programs: d.programs ?? [], recruits: d.recruits ?? [], total: d.total ?? 0 }),
  });
}

/** Show the partner's Recruit partners nav item: a program pays them for
 *  recruiting, or they already have recruits to look at. */
export function useShowRecruiting(principal: Principal): boolean {
  const recruits = useRecruits(principal.role === 'partner' ? principal.partnerId : null);
  return !!recruits.data && (recruits.data.programs.length > 0 || recruits.data.total > 0);
}

/** "10% of what your recruits earn, for their first 12 months". */
function shareSentence(p: PartnerRecruits['programs'][number], who: string): string {
  const months = p.recruiterCommissionMonths;
  const span = months ? `, for ${months} month${months === 1 ? '' : 's'} after each one joins` : '';
  return `${p.recruiterCommissionPercent}% of what ${who} earn${span}`;
}

function earnedText(earned: Record<string, string>): string {
  const entries = Object.entries(earned);
  if (entries.length === 0) return '—';
  return entries.map(([currency, amount]) => money(amount, currency)).join(' + ');
}

function RecruitsTable({ data, emptyHint }: { data: PartnerRecruits; emptyHint: string }) {
  if (data.recruits.length === 0) {
    return <EmptyState title="No recruits yet" hint={emptyHint} icon={<UserPlus size={28} strokeWidth={1.25} />} />;
  }
  return (
    <>
      <Table
        columns={['Partner', 'Joined', 'Status', { label: 'Earned', align: 'right' }]}
        rows={data.recruits.map((r) => [
          <span style={{ fontWeight: 500 }}>{r.name}</span>,
          <span style={{ color: theme.textMuted }}>{formatDate(r.recruitedAt, { relative: true })}</span>,
          <StatusPill status={r.status} />,
          <span style={{ fontWeight: 500 }}>{earnedText(r.earned)}</span>,
        ])}
      />
      {data.total > data.recruits.length && (
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 8 }}>
          Showing the newest {data.recruits.length} of {data.total}.
        </div>
      )}
    </>
  );
}

function RecruitLink({ url, signupOpen }: { url: string; signupOpen: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Input aria-label="Recruit link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <Button
          variant="secondary"
          icon={<Copy size={14} />}
          onClick={() => {
            navigator.clipboard.writeText(url).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {!signupOpen && (
        <div style={{ fontSize: 12, color: theme.warn, marginTop: 6 }}>
          The join page is closed right now, so the link won&rsquo;t sign anyone up until it reopens.
        </div>
      )}
    </div>
  );
}

/** The partner's own page: their link, what it pays, and who joined. */
export function RecruitPage({ principal }: { principal: Principal }) {
  const recruits = useRecruits(principal.partnerId);
  const data = recruits.data;
  return (
    <Page title="Recruit partners" subtitle="Bring in other partners and earn a share of what they earn.">
      <ErrorBanner error={recruits.error} />
      {recruits.isLoading || !data ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <Card style={{ marginBottom: 14 }}>
            {data.recruitUrl && data.programs.length > 0 ? (
              <>
                <Label>Your recruit link</Label>
                <RecruitLink url={data.recruitUrl} signupOpen={data.signupOpen} />
                <ul style={{ margin: '14px 0 0', paddingLeft: 18, fontSize: 13, color: theme.text, lineHeight: 1.6 }}>
                  {data.programs.map((p) => (
                    <li key={p.id}>
                      <strong>{p.name}</strong>: you earn {shareSentence(p, 'your recruits')}.
                    </li>
                  ))}
                </ul>
                <p style={{ fontSize: 12, color: theme.textDim, margin: '10px 0 0', lineHeight: 1.5 }}>
                  Partners who apply through your link become your recruits. Your share is paid on top of
                  what they earn, never out of it, and it&rsquo;s approved when their commission is. You
                  don&rsquo;t earn on partners your recruits bring in.
                </p>
              </>
            ) : (
              <p style={{ fontSize: 13, color: theme.textMuted, margin: 0, lineHeight: 1.5 }}>
                None of your programs pays for recruiting right now. What your earlier recruits earned you
                stays below.
              </p>
            )}
          </Card>
          <SectionHeading>Your recruits{data.total > 0 ? ` (${data.total})` : ''}</SectionHeading>
          <RecruitsTable data={data} emptyHint="Share your link with creators who'd be a good fit." />
        </>
      )}
    </Page>
  );
}

/** Admin partner page: who recruited this partner (set, change or clear),
 *  and the partners this one recruited. */
export function AdminPartnerRecruitingSection({ partnerId, partnerName }: { partnerId: string; partnerName: string }) {
  const recruits = useRecruits(partnerId);
  const [picking, setPicking] = useState(false);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (recruitedByPartnerId: string | null) =>
      api(`/partners/${partnerId}`, { method: 'PATCH', body: { recruitedByPartnerId } }),
    onSuccess: () => {
      setPicking(false);
      qc.invalidateQueries({ queryKey: ['partner-recruits'] });
      qc.invalidateQueries({ queryKey: ['partners'] });
    },
  });
  const data = recruits.data;

  return (
    <>
      <SectionHeading
        actions={
          data && !picking && (
            <Button size="sm" variant="secondary" icon={<UserPlus size={14} />} onClick={() => setPicking(true)}>
              {data.recruitedBy ? 'Change recruiter' : 'Set recruiter'}
            </Button>
          )
        }
      >
        Recruiting
      </SectionHeading>
      <ErrorBanner error={recruits.error ?? save.error} />
      {!data ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: theme.text, marginBottom: 6 }}>
              {data.recruitedBy ? (
                <>
                  Recruited by <strong>{data.recruitedBy.name}</strong> since{' '}
                  {new Date(data.recruitedBy.recruitedAt).toLocaleDateString()}.{' '}
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Remove ${data.recruitedBy!.name} as ${partnerName}'s recruiter? They stop earning on ${partnerName}'s commissions from now on.`)) {
                        save.mutate(null);
                      }
                    }}
                    disabled={save.isPending}
                    style={{ background: 'none', border: 'none', padding: 0, color: theme.danger, cursor: 'pointer', fontSize: 13 }}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <>Nobody recruited {partnerName}.</>
              )}
            </div>
            <p style={{ fontSize: 12, color: theme.textDim, margin: 0, lineHeight: 1.5 }}>
              {data.programs.length > 0
                ? `Their recruiter earns a share of what they earn: ${data.programs
                    .map((p) => `${p.recruiterCommissionPercent}% in ${p.name}`)
                    .join(', ')}. It starts when the recruiter is set; commissions already earned stay with whoever earned them.`
                : 'No program pays a recruiter share. Turn it on in a program’s settings under Programs.'}
            </p>
            {picking && (
              <RecruiterPicker
                excludeId={partnerId}
                saving={save.isPending}
                onPick={(id) => {
                  const replacing = data.recruitedBy;
                  if (
                    !replacing ||
                    window.confirm(`Replace ${replacing.name} as ${partnerName}'s recruiter? ${replacing.name} stops earning on ${partnerName}'s commissions from now on.`)
                  ) {
                    save.mutate(id);
                  }
                }}
                onCancel={() => setPicking(false)}
              />
            )}
            {data.recruitUrl && (
              <div style={{ marginTop: 14 }}>
                <Label>{partnerName}&rsquo;s recruit link</Label>
                <RecruitLink url={data.recruitUrl} signupOpen={data.signupOpen} />
              </div>
            )}
          </Card>
          {data.total > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 500, margin: '0 0 8px' }}>Partners {partnerName} recruited ({data.total})</div>
              <RecruitsTable data={data} emptyHint="" />
            </>
          )}
        </>
      )}
    </>
  );
}

function RecruiterPicker({
  excludeId,
  saving,
  onPick,
  onCancel,
}: {
  excludeId: string;
  saving: boolean;
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState('');
  const q = useDebouncedSearch(search);
  const list = usePartnerSearch<{ id: string; name: string; email: string; revokedAt: string | null }>(q, 20);
  const results = (list.data?.pages.flatMap((p) => p.partners) ?? []).filter((p) => p.id !== excludeId && !p.revokedAt);
  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      <Input aria-label="Search partners" type="search" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
        {results.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={saving}
            onClick={() => onPick(p.id)}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'baseline',
              textAlign: 'left',
              background: 'transparent',
              border: `1px solid ${alpha(theme.border, 0.6)}`,
              borderRadius: theme.radiusSm,
              padding: '6px 10px',
              color: theme.text,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {p.name} <span style={{ color: theme.textDim, fontSize: 12 }}>{p.email}</span>
          </button>
        ))}
        {results.length === 0 && !list.isLoading && (
          <div style={{ fontSize: 12, color: theme.textDim }}>No partners match.</div>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
