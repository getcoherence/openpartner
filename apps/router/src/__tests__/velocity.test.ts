import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('checkVelocity', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.VELOCITY_MAX = '3';
    process.env.VELOCITY_WINDOW_MS = '1000';
  });

  it('allows up to max, flags on overage', async () => {
    const { checkVelocity } = await import('../velocity.js');
    expect(checkVelocity('ip1', 'k')).toBe(false);
    expect(checkVelocity('ip1', 'k')).toBe(false);
    expect(checkVelocity('ip1', 'k')).toBe(false);
    expect(checkVelocity('ip1', 'k')).toBe(true);
  });

  it('treats different ips as separate', async () => {
    const { checkVelocity } = await import('../velocity.js');
    for (let i = 0; i < 3; i += 1) checkVelocity('ipA', 'k');
    expect(checkVelocity('ipA', 'k')).toBe(true);
    expect(checkVelocity('ipB', 'k')).toBe(false);
  });

  it('ignores null ip', async () => {
    const { checkVelocity } = await import('../velocity.js');
    for (let i = 0; i < 10; i += 1) expect(checkVelocity(null, 'k')).toBe(false);
  });
});
