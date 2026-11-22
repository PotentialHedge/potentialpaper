import { afterEach, describe, expect, it, vi } from 'vitest';
import { rateLimitConfig } from '@/server/ratelimit';

describe('rateLimitConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gives a person's account 2 a second, in bursts of 60", () => {
    expect(rateLimitConfig()).toEqual({ burst: 60, perSecond: 2 });
  });

  it('gives admins and bots a far larger bucket', () => {
    expect(rateLimitConfig(true)).toEqual({ burst: 2_000, perSecond: 200 });
  });

  it('takes each from its own variables', () => {
    vi.stubEnv('API_RATE_LIMIT_TRUSTED_PER_SECOND', '50');
    vi.stubEnv('API_RATE_LIMIT_PER_SECOND', '1');
    expect(rateLimitConfig(true).perSecond).toBe(50);
    expect(rateLimitConfig().perSecond).toBe(1);
  });
});
