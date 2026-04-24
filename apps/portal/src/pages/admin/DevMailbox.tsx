import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Copy, Check, ExternalLink } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Card, EmptyState, ErrorBanner, Page, formatDate } from '../../ui.js';

interface DevMessage {
  id: string;
  to: string;
  subject: string;
  body: string;
  html: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export function DevMailboxPage() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['dev-mailbox'],
    queryFn: () => api<{ messages: DevMessage[] }>('/dev/mailbox'),
    refetchInterval: 5000,
  });

  const messages = data?.messages ?? [];

  return (
    <Page title="Dev mailbox" subtitle="Mail the DevMailer captured. Refreshes every 5s.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : messages.length === 0 ? (
        <EmptyState
          title="Inbox empty"
          hint="Sign up or request a sign-in link and it'll appear here."
          icon={<Mail size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.map((m) => (
            <MessageCard key={m.id} message={m} />
          ))}
        </div>
      )}
    </Page>
  );
}

function MessageCard({ message }: { message: DevMessage }) {
  const match = message.body.match(/https?:\/\/\S+/);
  const link = match ? match[0] : null;
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<'html' | 'text'>(message.html ? 'html' : 'text');

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{message.subject}</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
            to <code>{message.to}</code> · {formatDate(message.createdAt, { relative: true })}
          </div>
        </div>
        {message.html && (
          <div style={{ display: 'flex', gap: 2, background: theme.bg, padding: 2, borderRadius: theme.radiusSm }}>
            {(['html', 'text'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  background: view === v ? theme.surface2 : 'transparent',
                  color: view === v ? theme.text : theme.textMuted,
                  border: 'none',
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: theme.radiusSm,
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontWeight: 500,
                }}
              >
                {v}
              </button>
            ))}
          </div>
        )}
      </div>
      {view === 'html' && message.html ? (
        <iframe
          title={message.subject}
          srcDoc={message.html}
          sandbox=""
          style={{
            width: '100%',
            height: 420,
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            background: '#fff',
          }}
        />
      ) : (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: theme.bg,
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            color: theme.text,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 200,
            overflow: 'auto',
          }}
        >
          {message.body}
        </pre>
      )}
      {link && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <a
            href={link}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: theme.accent,
              color: theme.accentInk,
              padding: '6px 12px',
              borderRadius: theme.radiusSm,
              fontSize: 12,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            <ExternalLink size={12} /> Open link
          </a>
          <button
            onClick={() => {
              navigator.clipboard.writeText(link);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              color: copied ? theme.success : theme.textMuted,
              padding: '6px 10px',
              borderRadius: theme.radiusSm,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </Card>
  );
}
