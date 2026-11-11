/**
 * Creator-portal API client.
 *
 * Backend mounts a reverse proxy at /api/creator-api/* that forwards to
 * the Network's /creators/* + /offerings/* endpoints with cookie
 * pass-through, so the Network's `op_network_creator_session` cookie
 * lands on app.openpartner.dev and Just Works for subsequent calls.
 */

import { getApiKey } from '../../api.js';

/**
 * These pages also run inside a brand's admin portal, as that brand's own
 * promoter profile (pages/admin/NetworkPromote.tsx): under
 * [/t/<slug>]/admin/network/promote, where the brand's API reaches the
 * Network for it and there is no creator session at all. Which of the two
 * a page is in is read from where it is mounted, so nothing has to be
 * threaded through the pages.
 */
const PROMOTE_AREA = /^((?:\/t\/[a-z0-9-]+)?)\/admin\/network\/promote(?:\/|$)/;

/** The tenant prefix ('' or '/t/<slug>') inside a brand's Promote area;
 *  null in the creator portal and everywhere else. */
export function promoteAreaPrefix(pathname: string = typeof window === 'undefined' ? '' : window.location.pathname): string | null {
  const m = PROMOTE_AREA.exec(pathname);
  return m ? m[1]! : null;
}

export const inPromoteArea = (): boolean => promoteAreaPrefix() !== null;

/** A page of this portal: `/creator<sub>`, or the same page of the brand's
 *  Promote area. `sub` starts with a slash ('/offerings/off_1'). */
export function creatorPath(sub: string): string {
  const tenant = promoteAreaPrefix();
  return tenant === null ? `/creator${sub}` : `${tenant}/admin/network/promote${sub}`;
}

/** Where calls go: the creator proxy, or the brand's own API acting as its
 *  promoter profile. */
function apiBase(): string {
  const tenant = promoteAreaPrefix();
  return tenant === null ? '/api/creator-api' : `/api${tenant}/admin/network/promoter-api`;
}

/** The admin portal's API key, when it signs in with one (as api() sends). */
function withBrandAuth(headers: Headers): Headers {
  const key = inPromoteArea() ? getApiKey() : null;
  if (key && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${key}`);
  return headers;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

export async function creatorApi<T = unknown>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  // Blob/File bodies pass through with their own content-type so
  // upload endpoints work without JSON wrapping.
  const isBinaryBody = init.body instanceof Blob;
  if (init.body !== undefined && !isBinaryBody && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (isBinaryBody && !headers.has('content-type')) {
    headers.set('content-type', (init.body as Blob).type || 'application/octet-stream');
  }
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: withBrandAuth(headers),
    credentials: 'include',
    body: init.body === undefined
      ? undefined
      : isBinaryBody
        ? (init.body as Blob)
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body),
  });
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, friendlyMessage(res, detail), detail);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

/** A file through the proxy (a conversation image), as a Blob. */
export async function creatorApiBlob(path: string): Promise<Blob> {
  const res = await fetch(`${apiBase()}${path}`, { credentials: 'include', headers: withBrandAuth(new Headers()) });
  if (!res.ok) throw new ApiError(res.status, `${res.status}`);
  return res.blob();
}

function friendlyMessage(res: Response, detail: unknown): string {
  const fallback = res.statusText ? `${res.status} ${res.statusText}` : `${res.status}`;
  if (!detail || typeof detail !== 'object') return fallback;
  const d = detail as Record<string, unknown>;
  if (typeof d.detail === 'string' && d.detail.length > 0) {
    return typeof d.error === 'string' ? `${d.error}: ${d.detail}` : d.detail;
  }
  if (typeof d.error === 'string' && d.error.length > 0) return d.error;
  return fallback;
}
