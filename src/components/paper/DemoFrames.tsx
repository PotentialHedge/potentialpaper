'use client';

import { useEffect } from 'react';
import { DEMO_HEIGHT_MESSAGE, DEMO_ORIGIN, MAX_DEMO_HEIGHT, MIN_DEMO_HEIGHT } from '@/lib/demos';

/**
 * Runs the demos in rendered Markdown (`server/pages/markdown.ts` writes each as a frame without a `src`).
 * Each is loaded once it is about to come on screen, and kept from then on: the browser's own
 * `loading="lazy"` starts a frame more than a screen away, which is every demo on a short page. Each
 * frame then takes the height its page reports, and the caption's button puts it full screen.
 *
 * `watch` is anything that changes when the HTML does, such as a preview's, so new frames are found.
 */
export function DemoFrames({ watch }: { watch?: unknown }) {
  useEffect(() => {
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.demo-frame[data-src]')];
    if (frames.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const frame = entry.target as HTMLIFrameElement;
          if (!frame.src && frame.dataset.src) frame.src = frame.dataset.src;
          observer.unobserve(frame);
        }
      },
      { rootMargin: '150px 0px' },
    );
    for (const frame of frames) observer.observe(frame);

    // A page sized by its frame (`height: 80vh`) answers each resize with another, by the same ratio, and
    // would shrink or grow for ever. Two steps the same way by the same ratio are that: the first step was
    // its height, so the frame goes back to it and stops following.
    const state = new Map<HTMLIFrameElement, { last: { from: number; to: number } | null; frozen: boolean }>();
    function onMessage(event: MessageEvent) {
      if (event.origin !== DEMO_ORIGIN) return;
      const frame = frames.find((f) => f.contentWindow === event.source);
      if (!frame) return;
      const s = state.get(frame) ?? { last: null, frozen: false };
      state.set(frame, s);
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (s.frozen || data?.type !== DEMO_HEIGHT_MESSAGE) return;
      if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return;
      const next = Math.round(Math.min(MAX_DEMO_HEIGHT, data.height));
      if (next < MIN_DEMO_HEIGHT) return;
      const current = frame.getBoundingClientRect().height;
      if (current === 0 || Math.abs(next - current) < 2) return;
      if (s.last && Math.abs(s.last.to - current) < 2) {
        const sameWay = next > current === s.last.to > s.last.from;
        if (sameWay && Math.abs(next / current - s.last.to / s.last.from) < 0.02) {
          s.frozen = true;
          frame.style.height = `${s.last.to}px`;
          frame.classList.add('demo-sized');
          return;
        }
      }
      s.last = { from: current, to: next };
      frame.style.height = `${next}px`;
      frame.classList.add('demo-sized');
    }
    window.addEventListener('message', onMessage);

    function onClick(event: MouseEvent) {
      const button = (event.target as Element | null)?.closest?.('[data-demo-fullscreen]');
      if (!button) return;
      const frame = button.closest('figure.demo')?.querySelector<HTMLIFrameElement>('iframe.demo-frame');
      if (!frame) return;
      if (!frame.src && frame.dataset.src) frame.src = frame.dataset.src;
      void frame.requestFullscreen?.();
    }
    document.addEventListener('click', onClick);

    return () => {
      observer.disconnect();
      window.removeEventListener('message', onMessage);
      document.removeEventListener('click', onClick);
    };
  }, [watch]);
  return null;
}
