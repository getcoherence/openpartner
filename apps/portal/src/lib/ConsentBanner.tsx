import { useEffect, useRef, type CSSProperties } from 'react';
import { theme } from '../theme.js';
import { Button } from '../ui.js';
import { analyticsEnabled, chooseAnalyticsConsent } from '../posthog.js';
import { browserSignalsOptOut, openConsentSettings, useConsentBannerOpen } from './consent.js';
import { useIsMobile } from './useMediaQuery.js';

export const COOKIE_POLICY_URL = 'https://openpartner.dev/cookies';

/**
 * The analytics consent banner, mounted once beside <App /> (main.tsx) so
 * it covers every surface: the brand + partner shell, the creator shell,
 * sign-in pages, public profiles and the ops console.
 *
 * Decline and Accept are the same button at the same size: refusing must
 * be as easy as agreeing. Nothing renders without VITE_POSTHOG_KEY, so
 * self-hosted builds never see it. It opens on a first visit (unless the
 * browser sends GPC / Do Not Track) and again from any CookieSettingsButton.
 */
export function ConsentBanner() {
  const open = useConsentBannerOpen();
  const isMobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);

  // Reopened from "Cookie settings": move focus to the choice so keyboard
  // and screen-reader users land on it.
  useEffect(() => {
    if (open && document.activeElement?.hasAttribute('data-consent-open')) ref.current?.focus();
  }, [open]);

  if (!analyticsEnabled || !open) return null;

  const buttonStyle: CSSProperties = isMobile ? { flex: 1, justifyContent: 'center' } : {};
  return (
    <div
      ref={ref}
      role="region"
      aria-label="Cookie consent"
      tabIndex={-1}
      style={{
        position: 'fixed',
        left: 16,
        right: 16,
        bottom: 16,
        // Above the mobile drawer (50) and modals, so "Cookie settings"
        // opened from inside the drawer is visible.
        zIndex: 60,
        maxWidth: isMobile ? undefined : 440,
        marginLeft: isMobile ? undefined : 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusMd,
        boxShadow: theme.shadowPopover,
        color: theme.textMuted,
        fontSize: 13,
        lineHeight: 1.5,
        outline: 'none',
      }}
    >
      <p style={{ margin: 0 }}>
        Can we use analytics cookies to see how the dashboard is used? Nothing loads unless you accept.{' '}
        <a href={COOKIE_POLICY_URL} target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
          Cookie policy
        </a>
      </p>
      {browserSignalsOptOut() && (
        <p style={{ margin: 0, color: theme.textDim, fontSize: 12 }}>
          Your browser asks sites not to track you, so analytics stay off unless you accept here.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="secondary" size="sm" style={buttonStyle} onClick={() => chooseAnalyticsConsent('denied')}>
          Decline
        </Button>
        <Button variant="secondary" size="sm" style={buttonStyle} onClick={() => chooseAnalyticsConsent('granted')}>
          Accept
        </Button>
      </div>
    </div>
  );
}

/**
 * "Cookie settings": reopens the banner so a choice can be changed or
 * withdrawn. Placed in every shell's footer area next to the theme toggle;
 * renders nothing when the build has no analytics.
 */
export function CookieSettingsButton({ style }: { style?: CSSProperties }) {
  if (!analyticsEnabled) return null;
  return (
    <button
      type="button"
      data-consent-open=""
      onClick={openConsentSettings}
      style={{
        background: 'transparent',
        border: 'none',
        padding: '2px 4px',
        color: theme.textDim,
        fontSize: 12,
        cursor: 'pointer',
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = theme.text;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = theme.textDim;
      }}
    >
      Cookie settings
    </button>
  );
}
