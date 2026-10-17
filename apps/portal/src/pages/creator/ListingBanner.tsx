import type { CSSProperties } from 'react';
import { isTrustedEmbedUrl } from '@openpartner/db';
import { theme } from '../../theme.js';

/** What the Network sends for an offering's video (built from the parsed
 *  YouTube / Vimeo / Loom link — see packages/db/src/program-video.ts). */
export interface OfferingVideo {
  provider: 'youtube' | 'vimeo' | 'loom';
  id: string;
  url: string;
  embedUrl: string;
}

/**
 * Wide banner across the top of a marketplace listing. The brand's cover
 * image when it set one; otherwise a wash made from its own logo — blurred
 * and scaled into a colour field — so every card gets a banner in the
 * brand's colours without a gap in the grid. No logo → the tinted base.
 */
export function ListingBanner({
  coverUrl,
  logoUrl,
  style,
}: {
  coverUrl: string | null | undefined;
  logoUrl: string | null | undefined;
  style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: 'relative',
        aspectRatio: '3 / 1',
        overflow: 'hidden',
        background: `linear-gradient(135deg, ${theme.accentSoft}, ${theme.surface2})`,
        ...style,
      }}
    >
      {coverUrl ? (
        <img src={coverUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          style={{
            position: 'absolute',
            left: '-25%',
            top: '-25%',
            width: '150%',
            height: '150%',
            objectFit: 'cover',
            filter: 'blur(28px) saturate(1.4)',
            opacity: 0.6,
          }}
        />
      ) : null}
    </div>
  );
}

/** 16:9 player for an offering's video. Renders nothing unless the embed
 *  URL is one our parser builds — the Network already guarantees that, so
 *  this is belt and braces against a bad upstream. */
export function ListingVideo({ video, title }: { video: OfferingVideo | null | undefined; title: string }) {
  if (!video || !isTrustedEmbedUrl(video.embedUrl)) return null;
  return (
    <div
      style={{
        aspectRatio: '16 / 9',
        borderRadius: theme.radiusMd,
        overflow: 'hidden',
        background: '#000', // video letterbox — black in both themes, like the player itself
        border: `1px solid ${theme.borderSubtle}`,
      }}
    >
      <iframe
        src={video.embedUrl}
        title={title}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        allow="encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}
