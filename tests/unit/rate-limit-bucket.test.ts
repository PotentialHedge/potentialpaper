import { describe, expect, it } from 'vitest';
import { accountRateLimit, rateLimitConfig } from '@/server/ratelimit';

const bot = { isBot: true, rateLimitPerSecond: null, rateLimitBurst: null };

describe("an account's request bucket", () => {
  it("is a bot's own limit when an admin set one", () => {
    expect(accountRateLimit({ ...bot, rateLimitPerSecond: 5, rateLimitBurst: 50 }, true)).toEqual({
      perSecond: 5,
      burst: 50,
    });
  });

  it('is the trusted bucket for a bot without one', () => {
    expect(accountRateLimit(bot, true)).toEqual(rateLimitConfig(true));
  });

  it("ignores a person's row, and half a limit", () => {
    const person = { isBot: false, rateLimitPerSecond: 500, rateLimitBurst: 5000 };
    expect(accountRateLimit(person, false)).toEqual(rateLimitConfig(false));
    expect(accountRateLimit({ ...bot, rateLimitPerSecond: 5 }, true)).toEqual(rateLimitConfig(true));
  });
});
