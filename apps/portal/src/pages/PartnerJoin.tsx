import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Plus, User, X } from 'lucide-react';
import {
  AUDIENCE_SIZES,
  AUDIENCE_SIZE_LABELS,
  PARTNER_APPLICATION_LIMITS as LIMITS,
  isAudienceSize,
  isHttpUrl,
  type AudienceSize,
} from '@openpartner/db';
import { ApiError, api, currentTenantSlug } from '../api.js';
import { alpha, theme } from '../theme.js';
import { CountryField, countryErrorMessage } from '../lib/CountryField.js';
import { AuthFrame } from './auth/Shared.js';
import { usePublicBrand } from '../lib/useBrand.js';

/**
 * Public "become a partner" page — the hosted front-end for
 * POST /partner-signup. Tenant-scoped: on a white-label custom domain it
 * lives at /join with the tenant's branding; path-based tenants get
 * /t/<slug>/join. This signs partners up for THIS brand's program only —
 * it is not the platform-level Network creator signup (which white-label
 * portals deliberately don't have).
 *
 * Applicants can't join without a complete profile: besides name + email
 * the form asks for a website or main channel, 1–5 social profiles, an
 * audience size and a pitch. The rules mirror the API's (validateJoinForm)
 * and Apply stays disabled until they pass.
 *
 * When the brand offers the OpenPartner Network (status.networkOffered —
 * never on white-label), an optional "also join the Network" checkbox sits
 * under the application. It starts UNCHECKED: sharing the applicant's
 * name and email with a separate service is a choice they make, and an
 * applicant who skips past it is simply asked again in the portal. A
 * pre-ticked box would turn "didn't notice" into consent.
 *
 * Post-submit states mirror the API: auto-approve sends a sign-in link
 * right away; require-review only acknowledges the application (the
 * sign-in link comes with the admin's approval); the endpoint
 * is deliberately non-enumerating (already-registered looks like success).
 */

type Phase =
  | { kind: 'form' }
  | { kind: 'sent'; review: boolean }
  | { kind: 'closed' };

export interface JoinFormValues {
  name: string;
  email: string;
  websiteUrl: string;
  /** One entry per input row; blank rows are ignored. */
  socialUrls: string[];
  audienceSize: AudienceSize | '';
  pitch: string;
}

type JoinField = keyof JoinFormValues;

export interface JoinApplication {
  websiteUrl: string;
  socialUrls: string[];
  audienceSize: AudienceSize;
  pitch: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Client-side mirror of POST /partner-signup's rules. Returns per-field
 * messages and, when there are none, the normalized application to send
 * (trimmed, blank social rows dropped, duplicates removed).
 */
export function validateJoinForm(v: JoinFormValues): {
  errors: Partial<Record<JoinField, string>>;
  application: JoinApplication | null;
} {
  const errors: Partial<Record<JoinField, string>> = {};
  if (!v.name.trim()) errors.name = 'Enter your name';
  if (!EMAIL_RE.test(v.email.trim())) errors.email = 'Enter a valid email address';

  const websiteUrl = v.websiteUrl.trim();
  if (!isHttpUrl(websiteUrl)) errors.websiteUrl = 'Enter a full link, starting with https://';

  const socials = v.socialUrls.map((s) => s.trim()).filter(Boolean);
  const socialUrls = [...new Set(socials)];
  if (socials.length === 0) errors.socialUrls = 'Add at least one social profile';
  else if (socials.some((s) => !isHttpUrl(s))) errors.socialUrls = 'Each profile must be a full link, starting with https://';
  else if (socialUrls.length > LIMITS.socialMax) errors.socialUrls = `Add at most ${LIMITS.socialMax} social profiles`;

  if (!isAudienceSize(v.audienceSize)) errors.audienceSize = 'Pick your audience size';

  const pitch = v.pitch.trim();
  if (pitch.length < LIMITS.pitchMin) errors.pitch = `Write at least ${LIMITS.pitchMin} characters`;
  else if (pitch.length > LIMITS.pitchMax) errors.pitch = `Keep it under ${LIMITS.pitchMax} characters`;

  const ok = Object.keys(errors).length === 0;
  return {
    errors,
    application: ok ? { websiteUrl, socialUrls, audienceSize: v.audienceSize as AudienceSize, pitch } : null,
  };
}

/** "creator.com" → "https://creator.com" on blur, so a missing scheme isn't
 *  what stops a creator applying. Anything else is left as typed. */
function withScheme(value: string): string {
  const v = value.trim();
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  const candidate = `https://${v.replace(/^\/+/, '')}`;
  if (!isHttpUrl(candidate)) return v;
  return new URL(candidate).hostname.includes('.') ? candidate : v;
}

/** A 400 invalid_body carries the API's own per-field messages. */
function invalidBodyMessage(e: ApiError): string {
  const detail = (e.detail as { detail?: { formErrors?: unknown; fieldErrors?: Record<string, unknown> } } | null)?.detail;
  const messages = [
    ...(Array.isArray(detail?.formErrors) ? detail.formErrors : []),
    ...Object.values(detail?.fieldErrors ?? {}).flatMap((m) => (Array.isArray(m) ? m : [])),
  ].filter((m): m is string => typeof m === 'string' && m.length > 0);
  const unique = [...new Set(messages)];
  return unique.length > 0
    ? `Please check your answers: ${unique.join('. ')}.`
    : `Please check your answers: links need to start with https:// and your pitch needs at least ${LIMITS.pitchMin} characters.`;
}

export function PartnerJoinPage() {
  const brand = usePublicBrand();
  const [values, setValues] = useState<JoinFormValues>({
    name: '',
    email: '',
    websiteUrl: '',
    socialUrls: [''],
    audienceSize: '',
    pitch: '',
  });
  const [touched, setTouched] = useState<Partial<Record<JoinField, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [networkOptIn, setNetworkOptIn] = useState(false);
  // Hosted platform only: where the applicant is based (country-access).
  const [country, setCountry] = useState('');
  const [outsideOccupiedRegions, setOutsideOccupiedRegions] = useState(false);
  // Closed (or reviewed) is known before anyone fills in the form. If the
  // check fails (an older API without it), the form still works and a
  // closed program answers the submit with signup_disabled.
  const status = useQuery({
    queryKey: ['partner-signup-status', currentTenantSlug()],
    queryFn: () =>
      api<{ open: boolean; reviewRequired: boolean; networkOffered?: boolean; countryRequired?: boolean }>(
        '/partner-signup/status',
      ),
    retry: false,
    staleTime: 60_000,
  });

  const { errors, application } = validateJoinForm(values);
  const networkOffered = status.data?.networkOffered === true;
  const countryRequired = status.data?.countryRequired === true;
  const countryMissing = countryRequired && (!country || (country === 'UA' && !outsideOccupiedRegions));
  const set = <K extends JoinField>(key: K, value: JoinFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const touch = (key: JoinField) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const shownError = (key: JoinField) => (touched[key] ? errors[key] : undefined);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!application || countryMissing) {
      setTouched({ name: true, email: true, websiteUrl: true, socialUrls: true, audienceSize: true, pitch: true });
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; status: string }>('/partner-signup', {
        method: 'POST',
        body: {
          name: values.name.trim(),
          email: values.email.trim().toLowerCase(),
          application,
          ...(networkOffered && networkOptIn ? { networkOptIn: true } : {}),
          ...(countryRequired ? { country, ...(country === 'UA' ? { outsideOccupiedRegions } : {}) } : {}),
        },
      });
      setPhase({ kind: 'sent', review: r.status.startsWith('pending_review') });
    } catch (e) {
      const code = e instanceof ApiError ? String(e.message) : '';
      if (code.includes('signup_disabled') || code.includes('plan_required')) {
        // Either the brand closed signups or its billing is inactive —
        // the partner-facing message is the same.
        setPhase({ kind: 'closed' });
      } else if (countryErrorMessage(code)) {
        setErr(countryErrorMessage(code));
      } else if (e instanceof ApiError && e.status === 400 && code.includes('invalid_body')) {
        setErr(invalidBodyMessage(e));
      } else {
        setErr('Something went wrong — try again in a minute.');
      }
    } finally {
      setBusy(false);
    }
  }

  const program = brand.isLoading ? '' : brand.programName;

  if (phase.kind === 'closed' || status.data?.open === false) {
    return (
      <AuthFrame title="Signups are closed" subtitle={`${program} isn't accepting new partner applications right now.`}>
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
          If you were invited directly, use the link from your invitation email
          {brand.supportEmail ? (
            <>
              {' '}or contact <a href={`mailto:${brand.supportEmail}`} style={{ color: theme.accentText }}>{brand.supportEmail}</a>
            </>
          ) : null}
          .
        </div>
      </AuthFrame>
    );
  }

  if (phase.kind === 'sent') {
    return (
      <AuthFrame
        title={phase.review ? 'Application received' : 'Check your inbox'}
        subtitle={
          phase.review
            ? `${program} reviews applications by hand — you'll get an email once you're approved.`
            : `If this email isn't already registered, we sent a sign-in link to ${values.email}. It's good for 15 minutes.`
        }
      >
        <div style={{ background: theme.successSoft, border: `1px solid ${alpha(theme.success, 0.333)}`, padding: 14, borderRadius: theme.radiusSm, fontSize: 13, color: theme.success }}>
          {phase.review
            ? "We've emailed you a confirmation. Your sign-in link comes with the approval."
            : 'Click the link to set up your partner dashboard.'}
        </div>
      </AuthFrame>
    );
  }

  const title = `Become a ${program ? `${program} ` : ''}partner`;
  if (status.isLoading) {
    // Don't show a form that might be closed.
    return (
      <AuthFrame title={title}>
        <div style={{ fontSize: 13, color: theme.textMuted }}>Loading…</div>
      </AuthFrame>
    );
  }

  const pitchLength = values.pitch.trim().length;
  const socialRows = values.socialUrls;
  const disabled = busy || !application || countryMissing;

  return (
    <AuthFrame
      title={title}
      subtitle={
        status.data?.reviewRequired
          ? `Tell us about you and your audience. Every field is required. ${program || 'The team'} reviews each application before you can sign in.`
          : 'Tell us about you and your audience. Every field is required.'
      }
    >
      <form onSubmit={submit} noValidate>
        <div style={{ position: 'relative' }}>
          <User size={15} style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none' }} />
          <input
            aria-label="Your name"
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            onBlur={() => touch('name')}
            placeholder="Your name"
            autoComplete="name"
            autoFocus
            style={iconInputStyle}
          />
        </div>
        <FieldError message={shownError('name')} />
        <div style={{ position: 'relative', marginTop: 10 }}>
          <Mail size={15} style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none' }} />
          <input
            aria-label="Email"
            type="email"
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
            onBlur={() => touch('email')}
            placeholder="you@example.com"
            autoComplete="email"
            style={iconInputStyle}
          />
        </div>
        <FieldError message={shownError('email')} />

        {countryRequired && (
          <>
            <FieldLabel htmlFor="join-country">Where are you based?</FieldLabel>
            <CountryField
              id="join-country"
              value={country}
              onChange={setCountry}
              outsideOccupiedRegions={outsideOccupiedRegions}
              onOutsideOccupiedRegionsChange={setOutsideOccupiedRegions}
              selectStyle={inputStyle}
            />
          </>
        )}

        <FieldLabel htmlFor="join-website">Website or main channel</FieldLabel>
        <input
          id="join-website"
          type="url"
          inputMode="url"
          value={values.websiteUrl}
          onChange={(e) => set('websiteUrl', e.target.value)}
          onBlur={() => {
            set('websiteUrl', withScheme(values.websiteUrl));
            touch('websiteUrl');
          }}
          placeholder="https://yourchannel.com"
          autoComplete="url"
          style={inputStyle}
        />
        <FieldError message={shownError('websiteUrl')} />

        <FieldLabel htmlFor="join-social-0">Social profiles</FieldLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {socialRows.map((url, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                id={`join-social-${i}`}
                aria-label={`Social profile ${i + 1}`}
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => set('socialUrls', socialRows.map((u, j) => (j === i ? e.target.value : u)))}
                onBlur={() => {
                  set('socialUrls', socialRows.map((u, j) => (j === i ? withScheme(u) : u)));
                  touch('socialUrls');
                }}
                placeholder={i === 0 ? 'https://instagram.com/you' : 'https://…'}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
              {socialRows.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove social profile ${i + 1}`}
                  onClick={() => set('socialUrls', socialRows.filter((_, j) => j !== i))}
                  style={iconButtonStyle}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {socialRows.length < LIMITS.socialMax && (
          <button type="button" onClick={() => set('socialUrls', [...socialRows, ''])} style={addButtonStyle}>
            <Plus size={13} /> Add another
          </button>
        )}
        <FieldError message={shownError('socialUrls')} />

        <FieldLabel htmlFor="join-audience">Audience size</FieldLabel>
        <select
          id="join-audience"
          value={values.audienceSize}
          onChange={(e) => {
            set('audienceSize', e.target.value as AudienceSize | '');
            touch('audienceSize');
          }}
          onBlur={() => touch('audienceSize')}
          style={inputStyle}
        >
          <option value="">Select your total audience</option>
          {AUDIENCE_SIZES.map((s) => (
            <option key={s} value={s}>{AUDIENCE_SIZE_LABELS[s]}</option>
          ))}
        </select>
        <FieldError message={shownError('audienceSize')} />

        <FieldLabel htmlFor="join-pitch">How would you promote {program || 'this program'}?</FieldLabel>
        <textarea
          id="join-pitch"
          value={values.pitch}
          onChange={(e) => set('pitch', e.target.value)}
          onBlur={() => touch('pitch')}
          rows={4}
          placeholder="Where you'd share it, what you'd make, and who would see it."
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <div
          data-testid="pitch-hint"
          style={{
            fontSize: 12,
            marginTop: 4,
            color: pitchLength > LIMITS.pitchMax ? theme.danger : theme.textDim,
          }}
        >
          {pitchLength < LIMITS.pitchMin
            ? `${pitchLength}/${LIMITS.pitchMin} characters minimum`
            : `${pitchLength}/${LIMITS.pitchMax} characters`}
        </div>
        <FieldError message={shownError('pitch')} />

        {networkOffered && (
          <label
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              marginTop: 16,
              padding: 12,
              background: theme.surface2,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={networkOptIn}
              onChange={(e) => setNetworkOptIn(e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <span style={{ fontSize: 13, lineHeight: 1.5, color: theme.text }}>
              <strong>Also join the OpenPartner Network</strong> (optional)
              <span style={{ display: 'block', marginTop: 4, color: theme.textMuted }}>
                The Network is a directory where other brands find creators for their partner programs. If you tick
                this, {program || 'this brand'} shares your name, email address, website, social profiles and audience
                size with it. Your pitch stays with {program || 'this brand'}. You can change this later in your partner
                portal.
              </span>
            </span>
          </label>
        )}

        {err && <div role="alert" style={{ color: theme.danger, fontSize: 13, marginTop: 10 }}>{err}</div>}
        <button
          type="submit"
          disabled={disabled}
          style={{
            marginTop: 16,
            width: '100%',
            padding: '10px 14px',
            background: theme.accent,
            color: theme.accentInk,
            border: 'none',
            borderRadius: theme.radiusSm,
            fontSize: 14,
            fontWeight: 600,
            cursor: busy ? 'wait' : disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {busy ? 'Submitting…' : 'Apply to join'}
        </button>
      </form>
    </AuthFrame>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{ display: 'block', fontSize: 12, color: theme.textMuted, fontWeight: 500, margin: '16px 0 6px' }}
    >
      {children}
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <div style={{ color: theme.danger, fontSize: 12, marginTop: 4 }}>{message}</div>;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
};

const iconInputStyle: React.CSSProperties = { ...inputStyle, padding: '10px 12px 10px 34px' };

const iconButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 36,
  height: 38,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.textMuted,
  cursor: 'pointer',
};

const addButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  marginTop: 8,
  padding: 0,
  background: 'none',
  border: 'none',
  color: theme.accentText,
  fontSize: 13,
  cursor: 'pointer',
};
