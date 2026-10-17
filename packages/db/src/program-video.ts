/**
 * Program video links — YouTube, Vimeo, Loom only.
 *
 * A brand pastes a share link; we keep only the provider + video id and
 * rebuild every URL from those, so nothing a brand typed ever lands in an
 * iframe `src`. Anything that doesn't parse to an allowlisted provider is
 * rejected. Kept identical to the Network's src/program-video.ts — this
 * copy validates at program save (API) and drives the editor preview
 * (portal); the Network's guards its public API. A link that passes here
 * must pass there, or the listing sync would be refused.
 */

export type VideoProvider = 'youtube' | 'vimeo' | 'loom';

export interface ProgramVideo {
  provider: VideoProvider;
  id: string;
  /** Canonical share URL — what we store. */
  url: string;
  /** Player URL for an iframe. YouTube uses its no-cookie domain; Vimeo
   *  gets do-not-track. */
  embedUrl: string;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/;
const LOOM_ID = /^[0-9a-f]{32}$/;

const YT_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtube-nocookie.com']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'player.vimeo.com']);
const LOOM_HOSTS = new Set(['loom.com']);

export function parseVideoUrl(raw: string): ProgramVideo | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') return youtube(segs[0]);
  if (YT_HOSTS.has(host)) {
    if (segs[0] === 'watch') return youtube(u.searchParams.get('v') ?? undefined);
    if (['shorts', 'embed', 'live', 'v'].includes(segs[0] ?? '')) return youtube(segs[1]);
    return null;
  }

  if (VIMEO_HOSTS.has(host)) {
    // vimeo.com/ID, vimeo.com/ID/HASH (unlisted), vimeo.com/channels/x/ID,
    // vimeo.com/showcase/S/video/ID, player.vimeo.com/video/ID?h=HASH.
    // A leading numeric segment is the id (its hash may be all digits);
    // otherwise the id is the last numeric segment.
    let idx = -1;
    for (let i = 0; i < segs.length; i += 1) {
      if (VIMEO_ID.test(segs[i]!)) {
        idx = i;
        if (i === 0) break;
      }
    }
    if (idx < 0) return null;
    const next = segs[idx + 1];
    const hash = next && VIMEO_HASH.test(next) ? next : u.searchParams.get('h') ?? undefined;
    return vimeo(segs[idx]!, hash && VIMEO_HASH.test(hash) ? hash : undefined);
  }

  if (LOOM_HOSTS.has(host)) {
    if ((segs[0] === 'share' || segs[0] === 'embed') && segs[1] && LOOM_ID.test(segs[1])) {
      return {
        provider: 'loom',
        id: segs[1],
        url: `https://www.loom.com/share/${segs[1]}`,
        embedUrl: `https://www.loom.com/embed/${segs[1]}`,
      };
    }
    return null;
  }
  return null;
}

function youtube(id: string | undefined): ProgramVideo | null {
  if (!id || !YT_ID.test(id)) return null;
  return {
    provider: 'youtube',
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0`,
  };
}

function vimeo(id: string, hash: string | undefined): ProgramVideo {
  return {
    provider: 'vimeo',
    id,
    url: hash ? `https://vimeo.com/${id}/${hash}` : `https://vimeo.com/${id}`,
    embedUrl: `https://player.vimeo.com/video/${id}?dnt=1${hash ? `&h=${hash}` : ''}`,
  };
}

/** Defense in depth for renderers: true only for player URLs this module
 *  builds. Embed `video.embedUrl` from the Network only when this holds. */
export function isTrustedEmbedUrl(url: string): boolean {
  return /^https:\/\/(www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}\?rel=0|player\.vimeo\.com\/video\/\d{1,12}\?dnt=1(&h=[0-9a-f]{6,20})?|www\.loom\.com\/embed\/[0-9a-f]{32})$/.test(
    url,
  );
}
