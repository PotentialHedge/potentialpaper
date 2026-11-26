import { afterEach, describe, expect, it } from 'vitest';
import { track } from '@/lib/track';

describe('track', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("never returns Umami's Promise, so an effect that calls it returns no cleanup", async () => {
    const sent: string[] = [];
    (globalThis as { window?: unknown }).window = {
      umami: {
        track: (name: string) => {
          sent.push(name);
          return Promise.reject(new Error('offline'));
        },
      },
    };
    expect(track('edit_web_opened')).toBeUndefined();
    expect(sent).toEqual(['edit_web_opened']);
    // Its rejection is caught, not left unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
