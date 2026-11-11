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
  /**
   * The first-run setup wizard (hosted, apps/portal SetupWizard). Started
   * when the brand first opens it; that, not "has no program", is what
   * keeps a half-finished wizard resumable after its first step creates
   * the program. Finished or left ("Finish later"), the portal stops
   * sending the brand there; the dashboard still offers it until finished.
   */
  wizardStartedAt: string | null;
  wizardCompletedAt: string | null;
  wizardExitedAt: string | null;
  /** The furthest step saved (0 = none yet), so a reload resumes there. */
  wizardStep: number;
}

export const WIZARD_LAST_STEP = 5;

/** What `POST /config/onboarding` accepts: flags, stamped here. */
export interface OnboardingPatch {
  networkListingSkipped?: boolean;
  wizardStarted?: boolean;
  wizardCompleted?: boolean;
  /** true: left for later. false: came back to it. */
  wizardExited?: boolean;
  /** Only ever moves forward. */
  wizardStep?: number;
}

function stepOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= WIZARD_LAST_STEP ? v : 0;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

export async function readOnboardingSettings(db: Knex, tenantId: string): Promise<OnboardingSettings> {
  const value = await getConfig<Partial<OnboardingSettings>>(db, tenantId, ONBOARDING_CONFIG_KEY);
  return {
    networkListingSkipped: value?.networkListingSkipped === true,
    wizardStartedAt: isoOrNull(value?.wizardStartedAt),
    wizardCompletedAt: isoOrNull(value?.wizardCompletedAt),
    wizardExitedAt: isoOrNull(value?.wizardExitedAt),
    wizardStep: stepOf(value?.wizardStep),
  };
}

export async function saveOnboardingSettings(
  db: Knex,
  tenantId: string,
  patch: OnboardingPatch,
): Promise<OnboardingSettings> {
  const current = await readOnboardingSettings(db, tenantId);
  const now = new Date().toISOString();
  const next: OnboardingSettings = {
    networkListingSkipped: patch.networkListingSkipped ?? current.networkListingSkipped,
    wizardStartedAt: current.wizardStartedAt ?? (patch.wizardStarted ? now : null),
    wizardCompletedAt: current.wizardCompletedAt ?? (patch.wizardCompleted ? now : null),
    wizardExitedAt:
      patch.wizardExited === undefined ? current.wizardExitedAt : patch.wizardExited ? (current.wizardExitedAt ?? now) : null,
    wizardStep: Math.max(current.wizardStep, stepOf(patch.wizardStep)),
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
