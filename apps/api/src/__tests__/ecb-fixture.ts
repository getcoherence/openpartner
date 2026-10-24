/**
 * A fixed ECB daily feed for tests, and a fetch stub that serves it while
 * passing every other request through. Rates are chosen so the arithmetic
 * is exact: 1 EUR = 1.10 USD = 88 INR, so 1 INR = 0.0125 USD.
 */

import { vi } from 'vitest';
import { clearFxRateCache, ECB_DAILY_URL } from '../fx.js';

export const ECB_DATE = '2026-10-16';

export const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
  <Cube>
    <Cube time='${ECB_DATE}'>
      <Cube currency='USD' rate='1.10'/>
      <Cube currency='JPY' rate='165.00'/>
      <Cube currency='GBP' rate='0.88'/>
      <Cube currency='INR' rate='88.00'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

/** USD per INR under ECB_XML. */
export const USD_PER_INR = 1.1 / 88;

/** A feed for another day: `rates` are units per EUR. */
export function ecbXml(date: string, rates: Record<string, string>): string {
  const cubes = Object.entries(rates)
    .map(([c, r]) => `      <Cube currency='${c}' rate='${r}'/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='${date}'>
${cubes}
    </Cube>
  </Cube>
</gesmes:Envelope>`;
}

export interface EcbStub {
  /** Requests made to the ECB URL. */
  calls: () => number;
  /** Serve another feed (or fail) from now on, as the next day would; the
   *  cached table is dropped so the next read fetches it. */
  serve: (next: string | 'down' | '500') => void;
  restore: () => void;
}

/** `ok` serves ECB_XML; `down` fails the request; `500` answers 500. */
export function stubEcbFetch(mode: 'ok' | 'down' | '500' = 'ok'): EcbStub {
  clearFxRateCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  let serving: string = mode === 'ok' ? ECB_XML : mode;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== ECB_DAILY_URL) return realFetch(input, init);
    calls += 1;
    if (serving === 'down') throw new TypeError('fetch failed');
    if (serving === '500') return new Response('unavailable', { status: 500 });
    return new Response(serving, { status: 200, headers: { 'content-type': 'text/xml' } });
  });
  return {
    calls: () => calls,
    serve: (next) => {
      serving = next;
      clearFxRateCache();
    },
    restore: () => {
      spy.mockRestore();
      clearFxRateCache();
    },
  };
}
