import { useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { theme } from '../theme.js';
import type { ProfileCompleteness } from './profile-incomplete.js';

/**
 * App-wide "complete your profile" nudge for Network creators. Brands only
 * find complete profiles, and the Network refuses applications from
 * incomplete ones, so a creator who never opens their profile page would
 * otherwise never learn why. Driven by GET /creators/me's checklist; the
 * callers share that query's cache with the profile page, so the banner
 * goes away as soon as a save completes the profile.
 *
 * Dismissal lasts for the browser session only (sessionStorage), never
 * permanently: an incomplete profile is a blocker, not a preference.
 */
export function ProfileCompletionBanner({
  profile,
  isMobile,
  dismissKey,
  renderLink,
}: {
  profile: ProfileCompleteness | null | undefined;
  isMobile: boolean;
  /** sessionStorage key; one per surface. */
  dismissKey: string;
  /** Renders the "Complete profile" link (router Link or TenantLink). */
  renderLink: (style: CSSProperties, children: ReactNode) => ReactNode;
}) {
  const [dismissed, setDismissed] = useState(() => readDismissed(dismissKey));
  if (dismissed || !profile || profile.profileComplete !== false) return null;

  const checklist = profile.profileChecklist;
  const missing = checklist ? checklist.filter((i) => !i.done) : (profile.profileMissing ?? []);
  const lead = checklist && checklist.length > 0
    ? `Your profile is ${checklist.length - missing.length} of ${checklist.length} complete.`
    : 'Your profile isn’t complete.';

  function dismiss() {
    try {
      window.sessionStorage.setItem(dismissKey, '1');
    } catch {
      /* storage blocked: dismiss for this page view only */
    }
    setDismissed(true);
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: isMobile ? '16px 16px 0' : '24px 40px 0' }}>
      <div
        role="region"
        aria-label="Complete your profile"
        style={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          alignItems: isMobile ? 'stretch' : 'center',
          gap: 12,
          background: theme.warnSoft,
          border: `1px solid ${theme.border}`,
          borderLeft: `3px solid ${theme.warn}`,
          borderRadius: theme.radiusMd,
          padding: '12px 14px',
          fontSize: 13,
          lineHeight: 1.5,
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', gap: 10, flex: 1, minWidth: 0, paddingRight: isMobile ? 24 : 0 }}>
          <AlertTriangle size={18} style={{ color: theme.warn, flexShrink: 0, marginTop: 1 }} />
          <div style={{ minWidth: 0, color: theme.text }}>
            <strong style={{ color: theme.warn }}>{lead}</strong>{' '}
            Brands can&rsquo;t find you, and you can&rsquo;t apply to programs, until it&rsquo;s finished.
            {missing.length > 0 && (
              <div style={{ color: theme.textMuted, marginTop: 2 }}>
                Still missing: {missing.map((m) => m.label).join(', ')}.
              </div>
            )}
          </div>
        </div>
        {renderLink(
          {
            display: 'inline-flex',
            justifyContent: 'center',
            alignItems: 'center',
            background: theme.accent,
            color: theme.accentInk,
            borderRadius: theme.radiusSm,
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          },
          'Complete profile',
        )}
        <button
          onClick={dismiss}
          aria-label="Dismiss for this session"
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.textMuted,
            cursor: 'pointer',
            padding: 2,
            display: 'inline-flex',
            flexShrink: 0,
            ...(isMobile ? { position: 'absolute', top: 10, right: 10 } : {}),
          }}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

function readDismissed(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
