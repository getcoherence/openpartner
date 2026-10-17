/**
 * USD conversion for platform billing (fx.ts). No database.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { convertToUsd, FxUnavailableError, getEcbRates, parseEcbDailyXml, usdPerUnit } from '../fx.js';
import { ECB_DATE, ECB_XML, stubEcbFetch, type EcbStub } from './ecb-fixture.js';

let stub: EcbStub | null = null;
afterEach(() => {
  stub?.restore();
  stub = null;
});

describe('parseEcbDailyXml', () => {
  it('reads the reference date and per-EUR rates', () => {
    const rates = parseEcbDailyXml(ECB_XML);
    expect(rates.date).toBe(ECB_DATE);
    expect(rates.perEur).toMatchObject({ EUR: 1, USD: 1.1, INR: 88, JPY: 165 });
  });

  it('refuses a feed with no USD rate', () => {
    expect(() => parseEcbDailyXml(ECB_XML.replace(/<Cube currency='USD'[^>]*\/>/, ''))).toThrow(FxUnavailableError);
  });

  it('refuses a feed with no reference date', () => {
    expect(() => parseEcbDailyXml('<Cube currency="USD" rate="1.1"/>')).toThrow(FxUnavailableError);
  });
});

describe('usdPerUnit', () => {
  const rates = parseEcbDailyXml(ECB_XML);

  it('crosses through EUR: USD per unit, not units per USD', () => {
    // 1 EUR = 1.10 USD = 88 INR → 1 INR = 1.10 / 88 = 0.0125 USD. Getting
    // this upside down bills 88² too much, so pin the direction.
    expect(usdPerUnit(rates, 'INR')).toBeCloseTo(0.0125, 12);
    expect(usdPerUnit(rates, 'EUR')).toBeCloseTo(1.1, 12);
    expect(usdPerUnit(rates, 'USD')).toBe(1);
  });

  it('is case-insensitive and null for a currency the ECB does not publish', () => {
    expect(usdPerUnit(rates, 'inr')).toBeCloseTo(0.0125, 12);
    expect(usdPerUnit(rates, 'AED')).toBeNull();
  });
});

describe('convertToUsd', () => {
  it('never reads the feed for USD-only amounts', async () => {
    stub = stubEcbFetch('down');
    expect(await convertToUsd({ USD: 85_000 })).toEqual({ amountUsd: 85_000, heldOut: {} });
    expect(await convertToUsd({})).toEqual({ amountUsd: 0, heldOut: {} });
    expect(stub.calls()).toBe(0);
  });

  it('converts the Oct 17 verification mix instead of adding INR as dollars', async () => {
    // The bug: 963,377 INR + 85,000 USD + 60,000 "inr" metered as $1,108,377.
    stub = stubEcbFetch('ok');
    const res = await convertToUsd({ USD: 85_000, INR: 1_023_377 });
    // 1,023,377 × 0.0125 = 12,792.2125 → 85,000 + 12,792.21
    expect(res.amountUsd).toBe(97_792.21);
    expect(res.fx).toEqual({ source: 'ecb', date: ECB_DATE, usdPerUnit: { INR: expect.closeTo(0.0125, 12) } });
    expect(res.heldOut).toEqual({});
  });

  it('holds out a currency with no published rate rather than guess', async () => {
    stub = stubEcbFetch('ok');
    const res = await convertToUsd({ USD: 10, INR: 800, AED: 500 });
    expect(res.amountUsd).toBe(20);
    expect(res.heldOut).toEqual({ AED: 500 });
    expect(Object.keys(res.fx!.usdPerUnit)).toEqual(['INR']);
  });

  it('throws FxUnavailableError when the feed is unreachable or errors', async () => {
    stub = stubEcbFetch('down');
    await expect(convertToUsd({ INR: 100 })).rejects.toBeInstanceOf(FxUnavailableError);
    stub.restore();
    stub = stubEcbFetch('500');
    await expect(convertToUsd({ INR: 100 })).rejects.toThrow(/ECB feed returned 500/);
  });

  it('reuses the fetched table across calls', async () => {
    stub = stubEcbFetch('ok');
    await getEcbRates();
    await convertToUsd({ INR: 1 });
    await convertToUsd({ GBP: 1 });
    expect(stub.calls()).toBe(1);
  });
});
