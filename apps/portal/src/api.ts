const KEY_STORAGE = 'op:apiKey';

export function getApiKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function setApiKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(KEY_STORAGE);
}

export async function api<T = unknown>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const key = getApiKey();
  const headers = new Headers(init.headers);
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'include',
    body: init.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    clearApiKey();
    throw new ApiError(res.status, 'unauthorized');
  }
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, `${res.status} ${res.statusText}`, detail);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

export interface Principal {
  role: 'admin' | 'partner';
  source?: string;
  partnerId?: string;
  partner?: { id: string; name: string; email: string; stripeConnected: boolean };
  admin?: { id: string; name: string; email: string };
}
