/**
 * Shared types + error class for both the browser and server entry
 * points.
 *
 * Keeping these in their own module means browser imports won't drag in
 * `fetch` polyfills or server-only code, and server imports won't touch
 * anything that references `window` or `document`.
 */

export class OpenPartnerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'OpenPartnerError';
  }
}

export interface IdentifyResponse {
  ok: boolean;
  identityId: string | null;
  firstStitch: boolean;
  backfilledAttributions?: number;
}

export interface EventAttribution {
  status: 'attributed' | 'no_identity' | 'no_click' | 'outside_window' | 'already_attributed';
  model?: 'last_click' | 'first_click' | 'linear' | 'position';
  touches?: Array<{
    clickId: string;
    partnerId: string;
    weight: number;
    attributionId: string;
    commissionId?: string;
  }>;
}

export interface EventResponse {
  ok: boolean;
  eventId: string;
  attribution: EventAttribution;
}

/**
 * Small fetch helper used by both entries. Normalizes non-2xx responses
 * into OpenPartnerError so callers can try/catch with a stable shape
 * instead of poking at Response objects themselves.
 */
export type JsonRequestInit = Omit<RequestInit, 'body'> & { body?: unknown };

export async function requestJson<T>(
  input: string,
  init: JsonRequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetchImpl(input, {
    ...init,
    headers,
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body),
  });

  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const errBody = (body ?? {}) as { error?: string; detail?: unknown };
    throw new OpenPartnerError(
      errBody.error ?? `${res.status} ${res.statusText}`,
      res.status,
      errBody.error,
      errBody.detail ?? body,
    );
  }

  return body as T;
}
