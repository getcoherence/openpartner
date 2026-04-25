import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { Button, ErrorBanner, Input, Label, Select } from '../ui.js';
import { AuthFrame } from './auth/Shared.js';

/**
 * WordPress-style first-run setup. Only reachable when no admin is
 * activated yet; once it succeeds, the page 409s so a second would-be
 * installer can't take over.
 *
 * Collects:
 *   - Admin identity (name + email)
 *   - Program (name + optional support email)
 *   - Mail transport (SMTP / Postmark / None) so the invite email can
 *     actually send without the admin needing env-level access.
 */

type MailKind = 'smtp' | 'postmark' | 'none';

export function InstallPage() {
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [programName, setProgramName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');

  const [mailKind, setMailKind] = useState<MailKind>('smtp');
  const [mailFrom, setMailFrom] = useState('');
  // SMTP
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  // Postmark
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
              mailKind === 'postmark'
                ? { serverToken: pmToken, messageStream: pmStream || 'outbound' }
                : undefined,
          },
        },
      }),
  });

  if (mut.isSuccess) {
    return (
      <AuthFrame
        title="Check your email"
        subtitle={`We sent a sign-in link to ${adminEmail}.`}
        brand={programName}
      >
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
          Click the link to activate your admin account. The link is good for 15 minutes.
          <br />
          <br />
          <span style={{ color: theme.textDim }}>
            Didn't get the email? Check your spam folder, or confirm the mail provider you
            just configured can deliver to <strong>{adminEmail}</strong>.
          </span>
        </div>
      </AuthFrame>
    );
  }

  const mailOk =
    mailKind === 'none' ||
    (mailKind === 'smtp' && smtpHost && mailFrom) ||
    (mailKind === 'postmark' && pmToken && mailFrom);
  const canSubmit = adminName && adminEmail && programName && mailOk && !mut.isPending;

  return (
    <AuthFrame
      title="Install OpenPartner"
      subtitle="First-run setup. Create your admin account, name your program, and configure email delivery."
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, color: theme.accent }}>
        <Rocket size={18} />
        <div style={{ fontSize: 13 }}>Welcome — let's get you set up.</div>
      </div>
      <ErrorBanner error={mut.error} />

      <SectionHead>You</SectionHead>
      <div style={{ marginBottom: 12 }}>
        <Label>Your name</Label>
        <Input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Ada Lovelace" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <Label>Your email</Label>
        <Input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="ada@example.com" />
      </div>

      <SectionHead>Program</SectionHead>
      <div style={{ marginBottom: 12 }}>
        <Label>Program name</Label>
        <Input value={programName} onChange={(e) => setProgramName(e.target.value)} placeholder="e.g. Acme Partners" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <Label>Support email (optional)</Label>
        <Input type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} placeholder="support@yourdomain.com" />
        <Hint>Shown to partners in their dashboard.</Hint>
      </div>

      <SectionHead>Email delivery</SectionHead>
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
          <Input
            type="email"
            value={mailFrom}
            onChange={(e) => setMailFrom(e.target.value)}
            placeholder='e.g. "Acme Partners" <partners@acme.com>'
          />
          <Hint>Sender identity on every email. Must be verified with your provider.</Hint>
        </div>
      )}
      {mailKind === 'smtp' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
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
            <Hint>Stored encrypted at rest. Leave blank if your SMTP allows unauthenticated relay.</Hint>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.textMuted, marginBottom: 16 }}>
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
          <div style={{ marginBottom: 16 }}>
            <Label>Message stream</Label>
            <Input value={pmStream} onChange={(e) => setPmStream(e.target.value)} placeholder="outbound" />
          </div>
        </>
      )}
      {mailKind === 'none' && (
        <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 16, lineHeight: 1.6 }}>
          The magic-link URL will print to the server process stdout. Only useful if you
          have access to the server console and are just trying things out.
        </div>
      )}

      <Button onClick={() => mut.mutate()} disabled={!canSubmit}>
        {mut.isPending ? 'Creating…' : 'Send me my setup link'}
      </Button>
    </AuthFrame>
  );
}

function SectionHead({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: theme.textDim,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        fontWeight: 600,
        margin: '4px 0 10px',
      }}
    >
      {children}
    </div>
  );
}

function Hint({ children }: { children: string }) {
  return <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>{children}</div>;
}
