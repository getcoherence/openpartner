import { z } from 'zod';

export const platformSchema = z.object({
  platform: z.enum(['youtube', 'twitter', 'instagram', 'tiktok', 'blog', 'podcast', 'other']),
  url: z.string().url(),
  followers: z.number().int().nonnegative().optional(),
});

export const payoutSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('recurring_percent'),
    percent: z.number().positive().max(100),
    durationMonths: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal('one_time_fee'),
    amount: z.number().positive(),
    currency: z.string().length(3).optional(),
  }),
  z.object({
    type: z.literal('tiered_percent'),
    tiers: z
      .array(z.object({ minRevenueUsd: z.number().nonnegative(), percent: z.number().positive().max(100) }))
      .min(1),
  }),
]);

export const bonusSchema = z.object({
  description: z.string().min(1),
  triggerRevenueUsd: z.number().positive(),
  bonusUsd: z.number().positive(),
});

export const termsSchema = z.object({
  payout: payoutSchema,
  bonuses: z.array(bonusSchema).optional(),
  cookieWindowDays: z.number().int().min(1).max(365),
  exclusions: z.array(z.string()).optional(),
});

export const vendorCreateSchema = z.object({
  name: z.string().min(2),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  websiteUrl: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
  description: z.string().max(1000).optional(),
  instanceUrl: z.string().url(),
  instanceKey: z.string().min(8), // the admin key on the vendor's instance
});

export const creatorCreateSchema = z.object({
  name: z.string().min(2),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_]+$/),
  email: z.string().email(),
  bio: z.string().max(2000).optional(),
  avatarUrl: z.string().url().optional(),
  platforms: z.array(platformSchema).optional(),
});

export const offeringCreateSchema = z.object({
  title: z.string().min(2).max(120),
  productUrl: z.string().url(),
  description: z.string().max(4000).optional(),
  heroImageUrl: z.string().url().optional(),
  vendorCampaignId: z.string().min(1),
  terms: termsSchema,
  published: z.boolean().optional(),
});

export const offeringUpdateSchema = offeringCreateSchema.partial();

export const requestCreateSchema = z.object({
  offeringId: z.string().min(1),
  message: z.string().max(2000).optional(),
});

export const requestDecideSchema = z.object({
  decisionNote: z.string().max(2000).optional(),
});
