import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;

export const stripe: Stripe | null = key ? new Stripe(key) : null;

export function requireStripe(): Stripe {
  if (!stripe) throw new Error('Stripe not configured (STRIPE_SECRET_KEY missing)');
  return stripe;
}

export type OpenPartnerMode = 'selfhost' | 'flat' | 'revshare';

export function getMode(): OpenPartnerMode {
  const m = process.env.OPENPARTNER_MODE ?? 'selfhost';
  if (m === 'selfhost' || m === 'flat' || m === 'revshare') return m;
  throw new Error(`Invalid OPENPARTNER_MODE: ${m}`);
}

export const REVSHARE_FEE_BPS = 300; // 3.00%
