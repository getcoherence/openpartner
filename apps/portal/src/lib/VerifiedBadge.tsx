import { BadgeCheck } from 'lucide-react';
import { alpha, theme } from '../theme.js';

/**
 * Marks a Network platform the creator proved they own (YouTube
 * description code, website DNS record). The Network sets `verified`;
 * this only renders it. `compact` is the icon alone, for dense lists.
 */
export function VerifiedBadge({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span role="img" aria-label="Verified" title="Verified account" style={{ display: 'inline-flex', color: theme.success }}>
        <BadgeCheck size={13} />
      </span>
    );
  }
  return (
    <span
      title="Account ownership verified"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        fontWeight: 500,
        color: theme.success,
        background: theme.successSoft,
        border: `1px solid ${alpha(theme.success, 0.333)}`,
        borderRadius: 999,
        padding: '3px 9px',
        whiteSpace: 'nowrap',
      }}
    >
      <BadgeCheck size={13} /> Verified
    </span>
  );
}
