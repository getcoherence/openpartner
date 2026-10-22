/**
 * Brand onboarding preferences: the Config key `onboarding`.
 *
 * The OpenPartner Network is optional. A headless or private program may
 * never want a marketplace listing, yet the dashboard's "Getting started"
 * card only hid once the brand was on the Network with a published program,
 * so such a brand could never clear it. "Not now" on the card's Network step
 * sets `networkListingSkipped`. While it is set, the onboarding status
 * (routes/onboarding.ts) and the setup checklist (brand-setup.ts) stop
 * counting the listing as missing.
 *
 * Joining the Network later is the brand changing its mind, so the routes
 * that connect it (routes/settings.ts) clear the skip with
 * `clearNetworkListingSkip`, and the publish step comes back. Offering the
 * Network to partners (`autoEnroll`) is a separate choice and doesn't touch
 * the skip.
 *
 * Set with `POST /config/onboarding`. A brand setting, so it travels with
 * the export bundle (export.ts PORTABLE_CONFIG_KEYS).
 */

import type { Knex } from 'knex';
import { getConfig, setConfig } from './config.js';

export const ONBOARDING_CONFIG_KEY = 'onboarding';

export interface OnboardingSettings {
  /** The brand said "Not now" to listing on the OpenPartner Network. */
  networkListingSkipped: boolean;
}

export async function readOnboardingSettings(db: Knex, tenantId: string): Promise<OnboardingSettings> {
  const value = await getConfig<Partial<OnboardingSettings>>(db, tenantId, ONBOARDING_CONFIG_KEY);
  return { networkListingSkipped: value?.networkListingSkipped === true };
}

export async function saveOnboardingSettings(
  db: Knex,
  tenantId: string,
  patch: Partial<OnboardingSettings>,
): Promise<OnboardingSettings> {
  const current = await readOnboardingSettings(db, tenantId);
  const next: OnboardingSettings = {
    networkListingSkipped: patch.networkListingSkipped ?? current.networkListingSkipped,
  };
  await setConfig(db, tenantId, ONBOARDING_CONFIG_KEY, next);
  return next;
}

/** The brand just joined the Network: its listing is wanted again. */
export async function clearNetworkListingSkip(db: Knex, tenantId: string): Promise<void> {
  if ((await readOnboardingSettings(db, tenantId)).networkListingSkipped) {
    await saveOnboardingSettings(db, tenantId, { networkListingSkipped: false });
  }
}
