/**
 * /booking/confirm?token=… — where the requester's confirmation email
 * lands. Confirming takes a click on purpose: mail scanners that prefetch
 * links would otherwise confirm requests on the requester's behalf.
 */
import { Link, useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { Button, Card } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi, ApiError } from './creator-api.js';

interface Confirmed {
  ok: true;
  creatorName: string;
  creatorHandle: string | null;
  packageTitle: string | null;
}

export function BookingConfirmPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const confirm = useMutation({
    mutationFn: () => creatorApi<Confirmed>('/bookings/confirm', { method: 'POST', body: { token } }),
  });

  const err = confirm.error instanceof ApiError ? confirm.error : null;
  const errorText =
    err?.status === 410 && (err.detail as { error?: string } | null)?.error === 'expired'
      ? 'This link has expired. Send your request again from the creator’s page.'
      : err?.status === 410
        ? 'This creator isn’t taking requests right now.'
        : err
          ? 'This link has already been used or isn’t valid.'
          : confirm.error
            ? 'Something went wrong. Try again in a moment.'
            : null;

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, padding: '64px 20px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <Card>
          {confirm.isSuccess ? (
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <MailCheck size={28} strokeWidth={1.5} style={{ color: theme.success, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 17, fontWeight: 600 }}>Request sent</div>
                <div style={{ fontSize: 14, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                  {confirm.data.creatorName} has your request
                  {confirm.data.packageTitle ? <> for <strong style={{ color: theme.text }}>{confirm.data.packageTitle}</strong></> : null}.
                  They&rsquo;ll reply to you by email.
                </div>
                {confirm.data.creatorHandle && (
                  <div style={{ marginTop: 14 }}>
                    <Link to={`/creators/${confirm.data.creatorHandle}`} style={{ color: theme.accentText, fontSize: 14 }}>
                      Back to {confirm.data.creatorName}&rsquo;s page
                    </Link>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 17, fontWeight: 600 }}>Confirm your booking request</div>
              <div style={{ fontSize: 14, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                Click below to send your request to the creator.
              </div>
              {errorText && (
                <div style={{ marginTop: 14, fontSize: 14, color: theme.danger, background: theme.dangerSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
                  {errorText}
                </div>
              )}
              <div style={{ marginTop: 18 }}>
                <Button onClick={() => confirm.mutate()} disabled={!token || confirm.isPending || !!err}>
                  {confirm.isPending ? 'Sending…' : 'Confirm and send'}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
