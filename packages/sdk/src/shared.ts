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
  /**
   * 'not_attributed' only appears on a replay (`replayed: true`) of an event
   * that didn't attribute the first time; which miss it was isn't stored.
   */
  status: 'attributed' | 'no_identity' | 'no_click' | 'outside_window' | 'already_attributed' | 'not_attributed';
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
  /** True when an earlier call with the same externalEventId already
   *  recorded this event; eventId and attribution are that call's. */
  replayed?: boolean;
}

export interface ConversionResponse extends EventResponse {
  /** The user the conversion was recorded under: the userId you passed, or
   *  the click's own `click:<clickId>` user. */
  userId: string;
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
