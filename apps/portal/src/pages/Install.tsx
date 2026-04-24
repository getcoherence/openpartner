import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { Button, ErrorBanner, Input, Label } from '../ui.js';
import { AuthFrame } from './auth/Shared.js';

/**
 * WordPress-style first-run setup. Only reachable when no admin is
 * activated yet; once it succeeds, the page 409s so a second would-be
 * installer can't take over.
 *
 * Single form collects:
 *   - Admin name + email (the first human admin)
 *   - Program name + support email (brand + partner contact)
 * On submit, OSS sends an invite magic-link to the admin's email. They
 * click it, land on /auth/magic, get a session, and the system is
 * fully installed.
 */
export function InstallPage() {
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [programName, setProgramName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api('/install', {
        method: 'POST',
        body: { adminName, adminEmail, programName, supportEmail: supportEmail || undefined },
      }),
  });

  if (mut.isSuccess) {
    return (
      <AuthFrame title="Check your email" subtitle={`We sent a sign-in link to ${adminEmail}.`}>
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
          Click the link to activate your admin account. The link is good for 15 minutes.
          <br />
          <br />
          <span style={{ color: theme.textDim }}>
            Nothing in your inbox? If you're running locally without email configured, the link
            printed to the <code>pnpm dev:api</code> terminal. Otherwise, check your mail
            provider config (<code>SMTP_*</code> or <code>POSTMARK_SERVER_TOKEN</code> +{' '}
            <code>MAIL_FROM</code>).
          </span>
        </div>
      </AuthFrame>
    );
  }

  const canSubmit = adminName && adminEmail && programName && !mut.isPending;

  return (
    <AuthFrame
      title="Install OpenPartner"
      subtitle="First-run setup. Create your admin account and name your partner program."
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, color: theme.accent }}>
        <Rocket size={18} />
        <div style={{ fontSize: 13 }}>Welcome — let's get you set up.</div>
      </div>
      <ErrorBanner error={mut.error} />
      <div style={{ marginBottom: 14 }}>
        <Label>Your name</Label>
        <Input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Ada Lovelace" />
      </div>
      <div style={{ marginBottom: 20 }}>
        <Label>Your email</Label>
        <Input
          type="email"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          placeholder="ada@example.com"
        />
      </div>
      <div style={{ height: 1, background: theme.borderSubtle, margin: '4px 0 18px' }} />
      <div style={{ marginBottom: 14 }}>
        <Label>Program name</Label>
        <Input
          value={programName}
          onChange={(e) => setProgramName(e.target.value)}
          placeholder="e.g. Coherence Partners"
        />
      </div>
      <div style={{ marginBottom: 18 }}>
        <Label>Support email (optional)</Label>
        <Input
          type="email"
          value={supportEmail}
          onChange={(e) => setSupportEmail(e.target.value)}
          placeholder="support@yourdomain.com"
        />
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
          Shown to partners in their dashboard for contacting the program.
        </div>
      </div>
      <Button onClick={() => mut.mutate()} disabled={!canSubmit}>
        {mut.isPending ? 'Creating…' : 'Send me my setup link'}
      </Button>
    </AuthFrame>
  );
}
