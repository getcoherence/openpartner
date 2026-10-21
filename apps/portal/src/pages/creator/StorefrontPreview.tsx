/**
 * How the creator's storefront reads on their public page, inside the
 * editor (/creator/storefront) and the setup flow: a compact profile
 * header, the storefront section in preview mode, and past collaborations.
 * Rendered from what's on screen, unsaved edits included.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { theme } from '../../theme.js';
import type { NetworkProfile } from '../../lib/NetworkProfileEditor.js';
import { publicStorefrontUrl } from '../../lib/public-site.js';
import { ListingBanner } from './ListingBanner.js';
import { StorefrontSection } from './StorefrontSection.js';
import type { StorefrontChannel, StorefrontPackage } from './storefront-shared.js';

/**
 * The right-hand column beside a form: keeps its content in view while the
 * page scrolls, down to the bottom of the column. CSS sticky can't do this
 * here: the shell's <main> is an overflow container that never scrolls
 * itself, so a sticky child would stick to it rather than the window.
 */
export function PreviewColumn({ children }: { children: ReactNode }) {
  const column = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const TOP = 20;
    const update = () => {
      const col = column.current;
      const box = inner.current;
      if (!col || !box) return;
      const room = col.offsetHeight - box.offsetHeight;
      const shift = Math.max(0, Math.min(TOP - col.getBoundingClientRect().top, room));
      box.style.transform = shift ? `translateY(${shift}px)` : '';
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    // The form and the preview change height as the creator edits.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (column.current) ro?.observe(column.current);
    if (inner.current) ro?.observe(inner.current);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, []);
  return (
    <div ref={column} style={{ alignSelf: 'stretch', minWidth: 0 }}>
      <div ref={inner} style={{ maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', willChange: 'transform' }}>
        {children}
      </div>
    </div>
  );
}

export function StorefrontPreview({
  profile,
  packages,
  channels,
  bookingsOpen,
  pastBrands,
}: {
  profile: NetworkProfile | undefined;
  /** Published packages, in order. */
  packages: StorefrontPackage[];
  channels: StorefrontChannel[];
  bookingsOpen: boolean;
  /** Overrides the saved list while it's being edited. */
  pastBrands?: string[];
}) {
  const name = profile?.name || 'Your name';
  const handle = profile?.handle ?? null;
  const brands = pastBrands ?? profile?.pastBrands ?? [];
  const publicPath = handle ? publicStorefrontUrl(handle) : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', flex: 1 }}>
          Preview
        </span>
        {publicPath && profile?.profileComplete !== false && (
          <a
            href={publicPath}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12.5, color: theme.accentText, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}
          >
            Open public page <ExternalLink size={11} />
          </a>
        )}
      </div>
      <div
        style={{
          background: theme.bg,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusMd,
          padding: 14,
          display: 'grid',
          gap: 12,
        }}
      >
        {!bookingsOpen && (
          <div style={{ fontSize: 12.5, color: theme.warn, background: theme.warnSoft, borderRadius: theme.radiusSm, padding: '8px 10px' }}>
            Bookings are off, so brands don&rsquo;t see this section yet.
          </div>
        )}
        <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusMd, overflow: 'hidden' }}>
          {/* The public page's banner: the cover, else a wash of the photo. */}
          <ListingBanner coverUrl={profile?.coverImageUrl} logoUrl={profile?.avatarUrl} style={{ aspectRatio: '4 / 1' }} />
          <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
            {profile?.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', background: theme.surface2 }} />
            ) : (
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: theme.accent,
                  color: theme.accentInk,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {name.charAt(0).toUpperCase()}
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{name}</div>
              {handle && <div style={{ fontSize: 12, color: theme.textMuted, fontFamily: theme.fontMono }}>@{handle}</div>}
            </div>
          </div>
        </div>
        <StorefrontSection creatorName={name} packages={packages} channels={channels} preview />
        {brands.length > 0 && (
          <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusMd, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Past collaborations</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {brands.map((b) => (
                <span
                  key={b}
                  style={{ background: theme.surface2, fontSize: 12, padding: '3px 9px', borderRadius: 12, border: `1px solid ${theme.borderSubtle}` }}
                >
                  {b}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
