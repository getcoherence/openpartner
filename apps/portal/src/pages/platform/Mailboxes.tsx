/**
 * The creator index's two mailboxes on the Network (openpartner-network
 * docs/creator-index.md §5.5): the outreach email's, and brands' invites'.
 * Each connects by Microsoft sign-in: "Connect Microsoft account" sends the
 * admin to Microsoft, which returns them to /platform/mailboxes/callback
 * (MailboxCallbackPage), and that hands the code to the Network through the
 * API. Either may name a shared mailbox it sends as, through the connected
 * user's Send As right.
 *
 * Without a connection a mailbox sends as the Network's env sets up, if at
 * all. A lost connection (Microsoft refused it) sends nothing until it's
 * reconnected or disconnected.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Page, formatDate } from '../../ui.js';
import { friendlyPlatformError, papi } from './lib.js';

export type MailboxKind = 'outreach' | 'invite';

export interface MailboxConnection {
  status: 'connected' | 'lost';
  account: string;
  accountName: string | null;
  sendAs: string | null;
  sendAsName: string | null;
  connectedAt: string;
  connectedByEmail: string;
  lostAt: string | null;
  lostReason: string | null;
}

/** As the Network reports it. `via` and `connection` are missing from a
 *  Network that predates connections. */
export interface MailboxState {
  configured: boolean;
  from: string | null;
  via?: 'microsoft_account' | 'graph_app' | 'smtp' | 'console' | null;
  connection?: MailboxConnection | null;
}

const LABEL: Record<MailboxKind, string> = { outreach: 'Outreach email', invite: 'Brands’ invites' };
const SEND_AS_PLACEHOLDER: Record<MailboxKind, string> = { outreach: 'Jo Smith <jo@example.com>', invite: 'OpenPartner <invites@example.com>' };

/** The connect flow's error codes, in a sentence. */
export function mailboxErrorText(code: string, detail?: string | null): string {
  switch (code) {
    case 'same_mailbox':
      return 'Brands’ invites and the outreach email can’t share a mailbox.';
    case 'invalid_state':
      return 'That sign-in expired or was already used. Start again.';
    case 'wrong_operator':
      return 'Another operator started that sign-in.';
    case 'sign_in_failed':
      return `Microsoft refused the sign-in${detail ? `: ${detail}` : '.'}`;
    case 'no_refresh_token':
      return 'Microsoft gave no offline access. Connect again and accept every permission.';
    case 'no_mailbox':
      return 'That account has no mailbox.';
    case 'not_connected':
      return 'Connect the mailbox first.';
    case 'invalid_body':
      return 'Send as takes an email address, like OpenPartner <invites@example.com>.';
    case 'microsoft_unreachable':
    case 'network_call_failed':
      return 'Couldn’t reach Microsoft or the Network. Try again.';
    default:
      return friendlyPlatformError(code);
  }
}

const sendAsText = (c: MailboxConnection | null | undefined) =>
  c?.sendAs ? (c.sendAsName ? `${c.sendAsName} <${c.sendAs}>` : c.sendAs) : '';

/** One mailbox: who it sends as and how, and the admin's controls. */
function MailboxRow({ kind, mailbox, oauth, canWrite, onChange }: { kind: MailboxKind; mailbox: MailboxState | undefined; oauth: boolean; canWrite: boolean; onChange: () => void }) {
  const connection = mailbox?.connection ?? null;
  const [sendAs, setSendAs] = useState(sendAsText(connection));
  useEffect(() => setSendAs(sendAsText(connection)), [connection?.sendAs, connection?.sendAsName]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = useMutation({
    mutationFn: () =>
      papi<{ authorizeUrl: string }>(`/platform-admin/creator-index/mailboxes/${kind}/connect`, {
        method: 'POST',
        body: { sendAs: sendAs.trim() || null },
      }),
    onSuccess: (r) => window.location.assign(r.authorizeUrl),
  });
  const saveSendAs = useMutation({
    mutationFn: () => papi(`/platform-admin/creator-index/mailboxes/${kind}/send-as`, { method: 'PUT', body: { sendAs: sendAs.trim() || null } }),
    onSuccess: onChange,
  });
  const disconnect = useMutation({
    mutationFn: () => papi(`/platform-admin/creator-index/mailboxes/${kind}`, { method: 'DELETE' }),
    onSuccess: onChange,
  });
  const error = connect.error ?? saveSendAs.error ?? disconnect.error;

  let status: React.ReactNode;
  if (connection?.status === 'lost') {
    status = (
      <>
        <span style={{ color: theme.danger }}>
          Connection lost {formatDate(connection.lostAt)} · {connection.account}
        </span>
        {connection.lostReason && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>{connection.lostReason}</div>}
      </>
    );
  } else if (connection) {
    status = (
      <>
        Connected as {connection.account} on {formatDate(connection.connectedAt)}
        {connection.sendAs && <> · sends as {connection.sendAs}</>}
      </>
    );
  } else if (mailbox?.configured) {
    status = <>{mailbox.from} · set up on the Network</>;
  } else {
    status = <span style={{ color: theme.textMuted }}>Not set up</span>;
  }

  const sendAsChanged = !!connection && sendAs.trim() !== sendAsText(connection);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0', borderTop: kind === 'invite' ? `1px solid ${theme.borderSubtle}` : undefined }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, minWidth: 130 }}>{LABEL[kind]}</span>
        <div style={{ fontSize: 13, flex: 1, minWidth: 200 }}>{status}</div>
        {canWrite && (oauth || connection) && (
          <div style={{ display: 'flex', gap: 8 }}>
            {oauth && (
              <Button size="sm" variant={connection?.status === 'connected' ? 'secondary' : 'primary'} onClick={() => connect.mutate()} disabled={connect.isPending}>
                {connection ? 'Reconnect' : 'Connect Microsoft account'}
              </Button>
            )}
            {/* Without the app on the Network a connection can't send, but
                can still be dropped, so env's setup sends again. */}
            {connection && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (window.confirm(`Disconnect ${connection.account}?`)) disconnect.mutate();
                }}
                disabled={disconnect.isPending}
              >
                Disconnect
              </Button>
            )}
          </div>
        )}
      </div>
      {canWrite && oauth && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: theme.textMuted, minWidth: 130 }}>Send as</span>
          <div style={{ flex: 1, minWidth: 220, maxWidth: 380 }}>
            <Input aria-label="Send as" placeholder={SEND_AS_PLACEHOLDER[kind]} value={sendAs} onChange={(e) => setSendAs(e.target.value)} />
          </div>
          {sendAsChanged && (
            <Button size="sm" variant="secondary" onClick={() => saveSendAs.mutate()} disabled={saveSendAs.isPending}>
              Save
            </Button>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 13, color: theme.danger }}>{mailboxErrorText(error.message)}</div>}
    </div>
  );
}

export function MailboxesSection({
  outreach,
  invite,
  oauth,
  canWrite,
  onChange,
}: {
  outreach: MailboxState | undefined;
  invite: MailboxState | undefined;
  oauth: boolean;
  canWrite: boolean;
  onChange: () => void;
}) {
  return (
    <div>
      <MailboxRow kind="outreach" mailbox={outreach} oauth={oauth} canWrite={canWrite} onChange={onChange} />
      <MailboxRow kind="invite" mailbox={invite} oauth={oauth} canWrite={canWrite} onChange={onChange} />
      {!oauth && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>Microsoft sign-in isn’t set up on the Network.</div>}
    </div>
  );
}

/** Where Microsoft returns the admin: hand the code to the Network once,
 *  then back to the creator index. */
export function MailboxCallbackPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const sent = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const refused = params.get('error');
    if (refused) {
      setError(mailboxErrorText('sign_in_failed', (params.get('error_description') ?? refused).split(/\r?\n| Trace ID:/)[0]));
      return;
    }
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      setError(mailboxErrorText('invalid_state'));
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/platform-admin/creator-index/mailboxes/callback', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, state }),
        });
        if (res.ok) {
          await qc.invalidateQueries({ queryKey: ['platform-creator-index'] });
          nav('/platform/creator-index', { replace: true });
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        setError(mailboxErrorText(body.error ?? String(res.status), body.detail));
      } catch {
        setError(mailboxErrorText('network_call_failed'));
      }
    })();
  }, [params, nav, qc]);

  return (
    <Page title="Connect mailbox">
      {error ? (
        <>
          <ErrorBanner error={error} />
          <Link to="/platform/creator-index" style={{ color: theme.accent, fontSize: 14 }}>
            Back to Creator index
          </Link>
        </>
      ) : (
        <Card>Connecting…</Card>
      )}
    </Page>
  );
}
