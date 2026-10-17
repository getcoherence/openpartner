/**
 * GET /programs carries customerRewardDelivery next to the list. The admin
 * reward editor words its promise from it ("applies automatically" vs
 * "create it in your own Stripe"), so a dropped or renamed field would
 * silently leave hosted brands with no guidance at all.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { customerRewardDelivery } from '../customer-rewards.js';

const ADMIN_KEY = 'op_test_reward_delivery_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

afterEach(() => {
  process.env.OPENPARTNER_MODE = 'selfhost';
});

afterAll(async () => {
  await db.destroy();
});

describe.skipIf(skipIntegration)('GET /programs customerRewardDelivery', () => {
  it('self-host reports its own delivery alongside the list', async () => {
    const res = await request(app).get('/programs').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.programs)).toBe(true);
    expect(res.body.customerRewardDelivery).toBe(customerRewardDelivery());
    expect(res.body.customerRewardDelivery).not.toBe('brand');
  });

  it('hosted reports brand — the discount is the brand’s to create', async () => {
    process.env.OPENPARTNER_MODE = 'flat';
    const res = await request(app).get('/programs').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.customerRewardDelivery).toBe('brand');
  });
});
