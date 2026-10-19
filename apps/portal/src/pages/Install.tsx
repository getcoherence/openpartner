import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Mail, Rocket } from 'lucide-react';
import { api, ApiError } from '../api.js';
import { alpha, softText, theme } from '../theme.js';
import { Button, ErrorBanner, Input, Label, Select } from '../ui.js';
import { AuthFrame } from './auth/Shared.js';

/**
 * Three-step first-run install:
 *   1. You      — admin identity (name + email)
 *   2. Program  — program name + optional support email
 *   3. Mail     — transport + credentials (so the invite email can send)
 * Final screen tells the admin to go check their inbox.
 *
 * Setup runs once. If its activation link is lost, the admin row already
 * exists, so POST /install 409s while /install/status still says
 * needsSetup. The resend screen asks POST /install/resend for a fresh link
 * to the address entered at setup.
 */

type MailKind = 'smtp' | 'postmark' | 'none';

interface InstallStatus {
  needsSetup: boolean;
  reason?: 'multi_tenant';
}

export function InstallPage() {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  // Set once setup has already run: `pending` when a submit 409'd, false
  // when the admin chose "resend" themselves.
  const [resend, setResend] = useState<{ pending: boolean } | null>(null);

  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [programName, setProgramName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [mailKind, setMailKind] = useState<MailKind>('smtp');
  const [mailFrom, setMailFrom] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [pmToken, setPmToken] = useState('');
  const [pmStream, setPmStream] = useState('outbound');

  const mut = useMutation({
    mutationFn: () =>
      api('/install', {
        method: 'POST',
        body: {
          adminName,
          adminEmail,
          programName,
          supportEmail: supportEmail || undefined,
          mail: {
            kind: mailKind,
            from: mailFrom || undefined,
            smtp:
              mailKind === 'smtp'
                ? {
                    host: smtpHost,
                    port: Number(smtpPort || 587),
                    secure: smtpSecure,
                    user: smtpUser || undefined,
                    password: smtpPass || undefined,
                  }
                : undefined,
            postmark:
              mailKind === 'postmark' ? { serverToken: pmToken, messageStream: pmStream || 'outbound' } : undefined,
          },
        },
      }),
    onError: async (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) return;
      // already_installed. Re-probe through the query App routes on: if
      // the admin activated meanwhile (another tab), needsSetup flips and
      // App leaves /install for sign-in. Otherwise the install is waiting
      // on an activation link.
      try {
        const status = await qc.fetchQuery({
          queryKey: ['install-status'],
          queryFn: () => api<InstallStatus>('/install/status'),
          staleTime: 0,
        });
        if (status.needsSetup) setResend({ pending: true });
      } catch {
        // Probe failed: leave the 409 on the banner.
      }
    },
  });

  if (resend) {
    return (
      <ResendActivation
        initialEmail={adminEmail}
        pending={resend.pending}
        brand={programName || undefined}
        onBack={() => {
          // Clear a 409 off the wizard; a sent invite keeps its screen.
          if (mut.isError) mut.reset();
          setResend(null);
        }}
      />
    );
  }

  if (mut.isSuccess) {
    return (
      <AuthFrame title="Check your email" subtitle={`We sent a sign-in link to ${adminEmail}.`} brand={programName}>
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
          Click the link to activate your admin account. The link is good for 15 minutes.
          <br />
          <br />
          <span style={{ color: theme.textDim }}>
            Didn't get it? Check your spam folder, or confirm the mail provider you just configured
            can deliver to <strong>{adminEmail}</strong>.
          </span>
        </div>
        <div style={{ marginTop: 16 }}>
          <Button variant="secondary" size="sm" icon={<Mail size={14} />} onClick={() => setResend({ pending: false })}>
            Resend the link
          </Button>
        </div>
      </AuthFrame>
    );
  }

  const steps = ['You', 'Program', 'Email delivery'];
  const stepValid =
    (step === 0 && adminName && adminEmail) ||
    (step === 1 && programName) ||
    (step === 2 &&
      (mailKind === 'none' ||
        (mailKind === 'smtp' && smtpHost && mailFrom) ||
        (mailKind === 'postmark' && pmToken && mailFrom)));
  const isLast = step === steps.length - 1;

  function onNext() {
    if (!stepValid) return;
    if (isLast) mut.mutate();
    else setStep(step + 1);
  }

  return (
    <AuthFrame title="Install OpenPartner" subtitle="First-run setup.">
      <Stepper steps={steps} current={step} />

      {step === 0 && (
        <>
          <WelcomeLine>Welcome — let's get you set up.</WelcomeLine>
          <div style={{ marginBottom: 12 }}>
            <Label>Your name</Label>
            <Input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Ada Lovelace" autoFocus />
          </div>
          <div style={{ marginBottom: 16 }}>
            <Label>Your email</Label>
            <Input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="ada@example.com" />
            <Hint>We'll send your activation link here.</Hint>
          </div>
          <div style={{ marginBottom: 4 }}>
            <Button variant="ghost" size="sm" onClick={() => setResend({ pending: false })}>
              Already ran setup? Resend the activation link
            </Button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <div style={{ marginBottom: 12 }}>
            <Label>Program name</Label>
            <Input value={programName} onChange={(e) => setProgramName(e.target.value)} placeholder="e.g. Acme Partners" autoFocus />
            <Hint>How partners see your program in the dashboard.</Hint>
          </div>
          <div style={{ marginBottom: 16 }}>
            <Label>Support email (optional)</Label>
            <Input type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} placeholder="support@yourdomain.com" />
            <Hint>Partners see this in their portal footer for questions.</Hint>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div style={{ marginBottom: 12 }}>
            <Label>Provider</Label>
            <Select value={mailKind} onChange={(e) => setMailKind(e.target.value as MailKind)}>
              <option value="smtp">SMTP (Gmail, SES, Mailgun, SendGrid, Postfix, …)</option>
              <option value="postmark">Postmark HTTP API</option>
              <option value="none">None — print to server console (dev only)</option>
            </Select>
          </div>
          {mailKind !== 'none' && (
            <div style={{ marginBottom: 12 }}>
              <Label>"From" address</Label>
              <Input type="email" value={mailFrom} onChange={(e) => setMailFrom(e.target.value)} placeholder='"Acme Partners" <partners@acme.com>' />
              <Hint>Sender identity on every email. Must be verified with your provider.</Hint>
            </div>
          )}
          {mailKind === 'smtp' && (
            <>
              <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <Label>SMTP host</Label>
                  <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
                </div>
                <div>
                  <Label>Port</Label>
                  <Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" />
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <Label>Username (optional)</Label>
                <Input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="apikey or username" />
              </div>
              <div style={{ marginBottom: 12 }}>
                <Label>Password</Label>
                <Input type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="••••••••" />
                <Hint>Stored encrypted at rest.</Hint>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.textMuted, marginBottom: 12 }}>
                <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
                Use implicit TLS (port 465). Leave unchecked for STARTTLS on 587.
              </label>
            </>
          )}
          {mailKind === 'postmark' && (
            <>
              <div style={{ marginBottom: 12 }}>
                <Label>Postmark server token</Label>
                <Input type="password" value={pmToken} onChange={(e) => setPmToken(e.target.value)} placeholder="••••••••" />
                <Hint>Stored encrypted at rest.</Hint>
              </div>
              <div style={{ marginBottom: 12 }}>
                <Label>Message stream</Label>
                <Input value={pmStream} onChange={(e) => setPmStream(e.target.value)} placeholder="outbound" />
              </div>
            </>
          )}
          {mailKind === 'none' && (
            <Hint>The magic-link URL will print to the server stdout. Dev / console-only use.</Hint>
          )}
        </>
      )}

      <ErrorBanner error={mut.error} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, gap: 8 }}>
        {step > 0 ? (
          <Button variant="secondary" icon={<ArrowLeft size={14} />} onClick={() => setStep(step - 1)}>
            Back
          </Button>
        ) : (
          <div />
        )}
        <Button
          onClick={onNext}
          disabled={!stepValid || mut.isPending}
          icon={isLast ? <Check size={14} /> : <ArrowRight size={14} />}
        >
          {isLast ? (mut.isPending ? 'Sending…' : 'Send my setup link') : 'Continue'}
        </Button>
      </div>
    </AuthFrame>
  );
}

/**
 * Fresh activation link for the admin setup created. The API mails only
 * an admin who's still waiting to activate, and answers the same either
 * way, so this screen can't confirm an address — it says "if".
 */
function ResendActivation({
  initialEmail,
  pending,
  brand,
  onBack,
}: {
  initialEmail: string;
  pending: boolean;
  brand?: string;
  onBack: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const mut = useMutation({
    mutationFn: () => api('/install/resend', { method: 'POST', body: { adminEmail: email } }),
  });

  return (
    <AuthFrame title="Check your inbox" subtitle="Or resend the activation link." brand={brand}>
      {pending && (
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6, marginBottom: 16 }}>
          Setup has already run on this server, so it can't run again. It sent an activation link to the
          admin email entered then.
        </div>
      )}

      {mut.isSuccess ? (
        <>
          <div
            style={{
              background: theme.successSoft,
              border: `1px solid ${alpha(theme.success, 0.333)}`,
              padding: 14,
              borderRadius: theme.radiusSm,
              fontSize: 13,
              color: theme.success,
            }}
          >
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Activation link sent</div>
            <div style={{ color: softText(theme.success) }}>
              If <strong>{email}</strong> is the admin waiting to activate, a new link is on its way. It's good for 15
              minutes.
            </div>
          </div>
          <Hint>
            Entered a different address at setup? Whoever holds the server's ADMIN_API_KEY can invite another admin
            with POST /admins.
          </Hint>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
            <Button variant="secondary" onClick={() => mut.reset()}>
              Send another link
            </Button>
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 16 }}>
            <Label>Admin email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
              autoFocus
            />
            <Hint>
              The address entered during setup. With no mail provider configured, the link prints to the API
              server's console.
            </Hint>
          </div>

          <ErrorBanner error={mut.error} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, gap: 8 }}>
            <Button variant="secondary" icon={<ArrowLeft size={14} />} onClick={onBack}>
              Back
            </Button>
            <Button onClick={() => mut.mutate()} disabled={!email.trim() || mut.isPending} icon={<Mail size={14} />}>
              {mut.isPending ? 'Sending…' : 'Resend activation link'}
            </Button>
          </div>
        </>
      )}
    </AuthFrame>
  );
}

function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const c = done ? theme.accentText : active ? theme.text : theme.textDim;
        const bg = done ? theme.accent : active ? theme.surface2 : 'transparent';
        const border = done ? theme.accent : active ? theme.accent : theme.border;
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: i === steps.length - 1 ? 0 : 1 }}>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: bg,
                border: `1px solid ${border}`,
                color: done ? theme.accentInk : c,
                fontSize: 11,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {done ? <Check size={12} /> : i + 1}
            </div>
            <div style={{ fontSize: 12, color: c, fontWeight: active ? 600 : 400, whiteSpace: 'nowrap' }}>{label}</div>
            {i !== steps.length - 1 && <div style={{ height: 1, flex: 1, background: theme.border, marginLeft: 4 }} />}
          </div>
        );
      })}
    </div>
  );
}

function WelcomeLine({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, color: theme.accentText }}>
      <Rocket size={16} />
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>{children}</div>;
}
