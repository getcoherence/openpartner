import { theme } from '../theme.js';

/**
 * Marks a Network creator who is a company: another brand's promoter
 * profile (the Network's Creator.kind 'brand'). Shown next to the name
 * wherever a brand reads who it is dealing with, and on the profile itself
 * in the creator portal.
 */
export function BrandBadge() {
  return (
    <span
      title="A brand on OpenPartner"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        background: theme.infoSoft,
        color: theme.info,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        verticalAlign: 'middle',
      }}
    >
      Brand
    </span>
  );
}
