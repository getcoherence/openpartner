import type { CSSProperties } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { theme } from '../theme.js';
import { useThemePreference, type ThemePreference } from './theme-preference.js';

const OPTIONS: { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

/**
 * System / Light / Dark segmented control. One component for every
 * surface: `labels` (sidebar footers — full width, icon + word) or the
 * compact icon-only form (public pages, the ops top bar). Each option is
 * a toggle button (aria-pressed) with an explicit accessible name, so the
 * icon-only form is still announced as "Light theme" etc.
 */
export function ThemeToggle({ labels = false, style }: { labels?: boolean; style?: CSSProperties }) {
  const [pref, setPref] = useThemePreference();
  return (
    <div
      role="group"
      aria-label="Color theme"
      style={{
        display: labels ? 'flex' : 'inline-flex',
        gap: 2,
        padding: 2,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm + 2,
        ...style,
      }}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = pref === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => setPref(value)}
            style={{
              flex: labels ? 1 : undefined,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              padding: labels ? '5px 6px' : '5px 7px',
              border: 'none',
              borderRadius: theme.radiusSm,
              background: active ? theme.surface : 'transparent',
              boxShadow: active ? `0 0 0 1px ${theme.border}` : 'none',
              color: active ? theme.text : theme.textMuted,
              fontSize: 12,
              fontWeight: active ? 500 : 400,
              lineHeight: 1,
              cursor: 'pointer',
              transition: 'background 120ms, color 120ms',
            }}
          >
            <Icon size={14} aria-hidden="true" />
            {labels && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
