import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Globe, AtSign, Building2, KeyRound, Signpost, Loader2, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { theme } from '../../theme.js';
import { AuthFrame } from './Shared.js';

export function VendorSignupPage() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [instanceUrl, setInstanceUrl] = useState('');
  const [instanceKey, setInstanceKey] = useState('');
  const [routerUrl, setRouterUrl] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const [verify, setVerify] = useState<VerifyState>({ state: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/auth/vendor/signup', {
        method: 'POST',
        body: {
          name,
          slug,
          email,
          instanceUrl,
          instanceKey,
          routerUrl: routerUrl || undefined,
          description: description || undefined,
          websiteUrl: websiteUrl || undefined,
        },
      });
      setSent(true);
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = e.detail as { error?: string; missing?: string[] } | undefined;
        const code = detail?.error;
        const messages: Record<string, string> = {
          slug_taken: 'That slug is already in use. Pick another.',
          instance_unreachable: 'Could not reach your OpenPartner instance. Check the URL.',
          instance_rejected_key: 'Your instance rejected that key. Double-check it.',
          missing_scopes: `Your key is missing required scopes: ${detail?.missing?.join(', ') ?? '—'}.`,
        };
        setErr((code ? messages[code] : undefined) ?? e.message);
      } else {
        setErr(e instanceof Error ? e.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthFrame title="Check your inbox" subtitle={`We sent a verification link to ${email}.`}>
        <div
          style={{
            background: theme.successSoft,
            border: `1px solid ${theme.success}55`,
            padding: 14,
            borderRadius: theme.radiusSm,
            fontSize: 13,
            color: theme.success,
          }}
        >
          Click the link within 15 minutes. After you verify, an admin reviews your federation credentials and activates your account — usually within a day.
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: theme.textDim }}>
          Running locally? Admins can open the <Link to="/admin/dev-mailbox" style={{ color: theme.accent }}>Dev mailbox</Link> to grab the link.
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Register your product" subtitle="List an offering on the OpenPartner Network.">
      <form onSubmit={submit}>
        <IconInput icon={<Building2 size={15} />} value={name} onChange={setName} placeholder="Product name" autoFocus />
        <IconInput
          icon={<AtSign size={15} />}
          value={slug}
          onChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          placeholder="slug"
          hint="Lowercase letters, digits, or -. Appears in URLs."
        />
        <IconInput icon={<Mail size={15} />} type="email" value={email} onChange={setEmail} placeholder="you@company.com" />

        <div style={{ marginTop: 8, marginBottom: 8, fontSize: 12, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Federation
        </div>
        <IconInput
          icon={<Globe size={15} />}
          value={instanceUrl}
          onChange={setInstanceUrl}
          placeholder="OpenPartner instance URL (e.g. https://api.acme.com)"
        />
        <IconInput
          icon={<KeyRound size={15} />}
          type="password"
          value={instanceKey}
          onChange={setInstanceKey}
          placeholder="Scoped API key (op_…)"
          hint={
            <span>
              Mint one on your instance with scopes <code>partners:write, partners:read, links:write, commissions:read</code>.
            </span>
          }
          afterInput={
            <VerifyButton
              disabled={!instanceUrl || !instanceKey || verify.state === 'loading'}
              onVerify={async () => {
                setVerify({ state: 'loading' });
                try {
                  const r = await api<VerifyResponse>('/network/vendors/verify-key', {
                    method: 'POST',
                    body: { instanceUrl, instanceKey },
                  });
                  setVerify({ state: 'done', result: r });
                } catch (e) {
                  setVerify({ state: 'error', message: e instanceof Error ? e.message : String(e) });
                }
              }}
              state={verify}
            />
          }
        />
        <IconInput
          icon={<Signpost size={15} />}
          value={routerUrl}
          onChange={setRouterUrl}
          placeholder="Router URL (e.g. https://getcoherence.io)"
          hint="Where share links resolve. Optional — dev skips this."
        />

        <div style={{ marginTop: 8, marginBottom: 8, fontSize: 12, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Profile (optional)
        </div>
        <IconInput icon={<Globe size={15} />} value={websiteUrl} onChange={setWebsiteUrl} placeholder="https://yoursite.com" />
        <div style={{ marginBottom: 12 }}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="A sentence or two for your directory card"
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 14,
              background: theme.surface2,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
              color: theme.text,
              fontFamily: theme.fontSans,
              resize: 'vertical',
            }}
          />
        </div>

        {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 8 }}>{err}</div>}
        <button
          type="submit"
          disabled={busy || !name || !slug || !email || !instanceUrl || !instanceKey}
          style={primaryBtnStyle(busy || !name || !slug || !email || !instanceUrl || !instanceKey)}
        >
          {busy ? 'Sending…' : 'Send verification link'}
        </button>
      </form>
      <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${theme.borderSubtle}`, fontSize: 13, color: theme.textDim }}>
        Want to promote products instead?{' '}
        <Link to="/signup" style={{ color: theme.accent, fontWeight: 500 }}>
          Creator signup
        </Link>
      </div>
    </AuthFrame>
  );
}

type VerifyState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; result: VerifyResponse }
  | { state: 'error'; message: string };

interface VerifyResponse {
  unrestricted?: boolean;
  missing?: string[];
  acceptable?: boolean;
  introspect?: { scopes?: string[] };
}

function VerifyButton({ disabled, onVerify, state }: { disabled: boolean; onVerify: () => void; state: VerifyState }) {
  let indicator: React.ReactNode = null;
  if (state.state === 'done') {
    const r = state.result;
    if (r.unrestricted) {
      indicator = (
        <span style={{ fontSize: 11, color: theme.warn, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ShieldAlert size={12} /> Admin key — strongly prefer scoped
        </span>
      );
    } else if (r.acceptable) {
      indicator = (
        <span style={{ fontSize: 11, color: theme.success, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ShieldCheck size={12} /> Scopes look good
        </span>
      );
    } else {
      indicator = (
        <span style={{ fontSize: 11, color: theme.danger, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ShieldX size={12} /> Missing: {(r.missing ?? []).join(', ')}
        </span>
      );
    }
  } else if (state.state === 'error') {
    indicator = (
      <span style={{ fontSize: 11, color: theme.danger, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <ShieldX size={12} /> {state.message}
      </span>
    );
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
      <button
        type="button"
        onClick={onVerify}
        disabled={disabled}
        style={{
          background: theme.surface2,
          color: theme.text,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusSm,
          padding: '5px 10px',
          fontSize: 12,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {state.state === 'loading' ? <Loader2 size={12} /> : <ShieldCheck size={12} />}
        {state.state === 'loading' ? 'Verifying…' : 'Verify key'}
      </button>
      {indicator}
    </div>
  );
}

function IconInput({
  icon,
  value,
  onChange,
  placeholder,
  type = 'text',
  hint,
  autoFocus,
  afterInput,
}: {
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
  hint?: React.ReactNode;
  autoFocus?: boolean;
  afterInput?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none', display: 'inline-flex' }}>
          {icon}
        </span>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={{
            width: '100%',
            padding: '10px 12px 10px 34px',
            fontSize: 14,
            background: theme.surface2,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            color: theme.text,
          }}
        />
      </div>
      {hint && <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>{hint}</div>}
      {afterInput}
    </div>
  );
}

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 6,
    width: '100%',
    padding: '10px 14px',
    background: theme.accent,
    color: theme.accentInk,
    border: 'none',
    borderRadius: theme.radiusSm,
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
