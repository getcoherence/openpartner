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
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`/api/creator-api${path}`, {
    ...init,
    headers,
    credentials: 'include',
    body: init.body === undefined
      ? undefined
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
    const detailMsg = (detail && typeof detail === 'object' && 'error' in detail)
      ? String((detail as { error: unknown }).error)
      : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, detailMsg, detail);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}
