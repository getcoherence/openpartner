/**
 * Creator-portal API client.
 *
 * Backend mounts a reverse proxy at /api/creator-api/* that forwards to
 * the Network's /creators/* + /offerings/* endpoints with cookie
 * pass-through, so the Network's `op_network_creator_session` cookie
 * lands on app.openpartner.dev and Just Works for subsequent calls.
 */

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
  const res = await fetch(`/api/creator-api${path}`, {
    ...init,
    headers,
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
