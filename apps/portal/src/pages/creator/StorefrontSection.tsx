/**
 * The storefront on a creator's public profile: their packages and a
 * booking-request form. Anyone can send a request; the Network emails the
 * requester a confirmation link and only a confirmed request reaches the
 * creator (the Network's docs/creator-storefront.md).
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { Button, Card, ErrorBanner, Input, Label, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import { formatPackagePrice, PLATFORM_LABELS, type StorefrontPackage } from './storefront-shared.js';

/** Which request the form is for: a package, or a custom collaboration. */
type Selection = { pkg: StorefrontPackage | null } | null;

export function StorefrontSection({
  handle,
  creatorName,
  packages,
}: {
  handle: string;
  creatorName: string;
  packages: StorefrontPackage[];
}) {
  const [selection, setSelection] = useState<Selection>(null);
  const firstName = creatorName.split(' ')[0] || creatorName;

  return (
    <>
      <div style={{ height: 14 }} />
      <Card>
        <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, fontWeight: 500 }}>Work with {firstName}</h3>
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
          Pick a package and send a request. {firstName} gets back to you by email.
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {packages.map((p) => (
            <div
              key={p.id}
              style={{
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusSm,
                padding: '14px 16px',
                background: theme.surface,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{p.title}</div>
                  {p.platform && (
                    <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>{PLATFORM_LABELS[p.platform] ?? p.platform}</div>
                  )}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{formatPackagePrice(p)}</div>
              </div>
              {p.description && (
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {p.description}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <Button size="sm" onClick={() => setSelection({ pkg: p })}>Request →</Button>
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: packages.length > 0 ? 14 : 0,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ flex: 1, fontSize: 13, color: theme.textMuted }}>
            {packages.length > 0 ? 'Looking for something custom?' : `${firstName} takes collaboration requests.`}
          </span>
          <Button size="sm" variant="secondary" onClick={() => setSelection({ pkg: null })}>
            Get in touch
          </Button>
        </div>
      </Card>

      {selection && (
        <RequestForm
          key={selection.pkg?.id ?? 'custom'}
          handle={handle}
          creatorName={creatorName}
          pkg={selection.pkg}
          onClose={() => setSelection(null)}
        />
      )}
    </>
  );
}

function RequestForm({
  handle,
  creatorName,
  pkg,
  onClose,
}: {
  handle: string;
  creatorName: string;
  pkg: StorefrontPackage | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [company, setCompany] = useState('');
  const [website, setWebsite] = useState('');
  const [budgetNote, setBudgetNote] = useState('');
  const [brief, setBrief] = useState('');
  // Honeypot — hidden from people, so only bots fill it in.
  const [website2, setWebsite2] = useState('');

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const send = useMutation({
    mutationFn: () =>
      creatorApi(`/creators/by-handle/${encodeURIComponent(handle)}/bookings`, {
        method: 'POST',
        body: {
          packageId: pkg?.id ?? null,
          contactName: contactName.trim(),
          contactEmail: contactEmail.trim(),
          company: company.trim() || null,
          website: normalizeWebsite(website),
          budgetNote: budgetNote.trim() || null,
          brief: brief.trim(),
          ...(website2 ? { website2 } : {}),
        },
      }),
  });

  const briefShort = brief.trim().length < 20;
  const canSend = contactName.trim() && /.+@.+\..+/.test(contactEmail.trim()) && !briefShort && !send.isPending;

  return (
    <div ref={ref} style={{ scrollMarginTop: 20 }}>
      <div style={{ height: 14 }} />
      <Card>
        {send.isSuccess ? (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <MailCheck size={28} strokeWidth={1.5} style={{ color: theme.accentText, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>Check your inbox</div>
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                We sent a link to <strong style={{ color: theme.text }}>{contactEmail.trim()}</strong>. Click it to send your
                request to {creatorName}. The link works for 48 hours.
              </div>
              <div style={{ marginTop: 12 }}>
                <Button size="sm" variant="secondary" onClick={onClose}>Done</Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 500 }}>
                  {pkg ? `Request: ${pkg.title}` : `Get in touch with ${creatorName}`}
                </div>
                {pkg && <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 2 }}>{formatPackagePrice(pkg)}</div>}
              </div>
            </div>
            <ErrorBanner error={send.error} />
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <Label>Your name</Label>
                  <Input aria-label="Your name" value={contactName} maxLength={120} autoComplete="name" onChange={(e) => setContactName(e.target.value)} />
                </div>
                <div>
                  <Label>Work email</Label>
                  <Input
                    type="email"
                    aria-label="Work email"
                    value={contactEmail}
                    maxLength={254}
                    autoComplete="email"
                    onChange={(e) => setContactEmail(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Company</Label>
                  <Input aria-label="Company" value={company} maxLength={120} autoComplete="organization" onChange={(e) => setCompany(e.target.value)} />
                </div>
                <div>
                  <Label>Website</Label>
                  <Input aria-label="Website" value={website} maxLength={300} placeholder="yourcompany.com" onChange={(e) => setWebsite(e.target.value)} />
                </div>
              </div>
              <div>
                <Label>Budget (optional)</Label>
                <Input aria-label="Budget" value={budgetNote} maxLength={120} placeholder="e.g. $1,000–2,000" onChange={(e) => setBudgetNote(e.target.value)} />
              </div>
              <div>
                <Label>What do you have in mind?</Label>
                <Textarea
                  aria-label="What do you have in mind?"
                  value={brief}
                  rows={5}
                  maxLength={2000}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder="Your product, what you'd like the post to cover, and any timing."
                />
              </div>
              <div aria-hidden="true" style={{ position: 'absolute', left: -10000, width: 1, height: 1, overflow: 'hidden' }}>
                <label>
                  Leave this empty
                  <input tabIndex={-1} autoComplete="off" value={website2} onChange={(e) => setWebsite2(e.target.value)} />
                </label>
              </div>
            </div>
            <div style={{ fontSize: 12, color: theme.textDim, marginTop: 12 }}>
              We email you a link to confirm before {creatorName} sees your request. {creatorName} sees your name, email,
              company and message.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <Button onClick={() => send.mutate()} disabled={!canSend}>
                {send.isPending ? 'Sending…' : 'Send request'}
              </Button>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** "acme.com" → "https://acme.com"; blank → null. The Network only accepts
 *  http(s) URLs. */
function normalizeWebsite(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** Footer on every public profile: the storefront's growth loop. */
export function GetYourStorefront() {
  return (
    <div
      style={{
        marginTop: 28,
        paddingTop: 16,
        borderTop: `1px solid ${theme.borderSubtle}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        fontSize: 13,
        color: theme.textMuted,
      }}
    >
      <span>Built with OpenPartner</span>
      <Link to="/creator/signup" style={{ color: theme.accentText, textDecoration: 'none', fontWeight: 500 }}>
        Are you a creator? Get your own storefront →
      </Link>
    </div>
  );
}
