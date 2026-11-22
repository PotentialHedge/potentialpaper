'use client';

import { useEffect } from 'react';
import { DEMO_HEIGHT_MESSAGE, demoOfHost, MAX_DEMO_HEIGHT, MIN_DEMO_HEIGHT } from '@/lib/demos';

/**
 * Runs the demos in rendered Markdown (`server/pages/markdown.ts` writes each as a frame without a `src`).
 * Each is loaded once it is about to come on screen, and kept from then on: the browser's own
 * `loading="lazy"` starts a frame more than a screen away, which is every demo on a short page. Each
 * frame then takes the height its page reports (growing at once, shrinking once the reader lets go of it), and the
 * caption's button puts it full screen.
 */
export function DemoFrames() {
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

    // Each frame grows to its page's height at once, but shrinks only once the pointer has left it and the page
    // has stayed shorter for a moment: a demo that shows and hides results as its controls change would otherwise
    // move everything below it on each click.
    //
    // A page sized by its frame (`height: 80vh`) answers each resize with another, by the same ratio, and would grow
    // for ever. Two steps the same way by the same ratio, the second reported right after the first was made, are
    // that: the first step was its height, so the frame goes back to it and stops following. A report seconds after
    // a resize is the reader using the demo.
    const SHRINK_DELAY = 800;
    const LOOP_WINDOW = 400;
    interface FrameState {
      last: { from: number; to: number; at: number } | null;
      frozen: boolean;
      /** The height the page last reported, and whether it came right after the frame's last resize. */
      wanted: number;
      quick: boolean;
      hovered: boolean;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
    const state = new Map<HTMLIFrameElement, FrameState>();
    const stateOf = (frame: HTMLIFrameElement) => {
      let s = state.get(frame);
      if (!s) {
        s = { last: null, frozen: false, wanted: 0, quick: false, hovered: false, timer: undefined };
        state.set(frame, s);
      }
      return s;
    };

    function setHeight(frame: HTMLIFrameElement, s: FrameState, next: number) {
      const current = frame.clientHeight;
      if (current === 0 || Math.abs(next - current) < 2) return;
      if (s.last && s.quick && Math.abs(s.last.to - current) < 2) {
        const sameWay = next > current === s.last.to > s.last.from;
        if (sameWay && Math.abs(next / current - s.last.to / s.last.from) < 0.02) {
          s.frozen = true;
          frame.style.height = `${s.last.to}px`;
          return;
        }
      }
      s.last = { from: current, to: next, at: performance.now() };
      frame.style.height = `${next}px`;
      frame.classList.add('demo-sized');
    }

    /** Shrinks the frame to its page's height once the reader has let go of it. */
    function settle(frame: HTMLIFrameElement, s: FrameState) {
      clearTimeout(s.timer);
      s.timer = undefined;
      if (s.frozen || s.hovered || s.wanted === 0) return;
      if (s.wanted < frame.clientHeight) {
        s.timer = setTimeout(() => {
          s.timer = undefined;
          if (!s.hovered && !s.frozen) setHeight(frame, s, s.wanted);
        }, SHRINK_DELAY);
      }
    }

    function onMessage(event: MessageEvent) {
      // From the frame's own demo: each has a host of its own (`lib/demos.ts`).
      const frame = frames.find((f) => f.contentWindow === event.source);
      if (!frame || !demoOfHost(URL.parse(event.origin)?.hostname ?? '') || !frame.src.startsWith(`${event.origin}/`))
        return;
      const s = stateOf(frame);
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (s.frozen || data?.type !== DEMO_HEIGHT_MESSAGE) return;
      if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return;
      const next = Math.round(Math.min(MAX_DEMO_HEIGHT, data.height));
      if (next < MIN_DEMO_HEIGHT) return;
      s.wanted = next;
      s.quick = s.last !== null && performance.now() - s.last.at < LOOP_WINDOW;
      // The first height, and any growth, at once; a shrink waits (`settle`).
      if (!frame.classList.contains('demo-sized') || next > frame.clientHeight) {
        clearTimeout(s.timer);
        s.timer = undefined;
        setHeight(frame, s, next);
      } else {
        settle(frame, s);
      }
    }
    const hover = (event: Event) => {
      const frame = event.currentTarget as HTMLIFrameElement;
      const s = stateOf(frame);
      s.hovered = event.type === 'pointerenter';
      settle(frame, s);
    };
    for (const frame of frames) {
      frame.addEventListener('pointerenter', hover);
      frame.addEventListener('pointerleave', hover);
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
      for (const frame of frames) {
        frame.removeEventListener('pointerenter', hover);
        frame.removeEventListener('pointerleave', hover);
        clearTimeout(state.get(frame)?.timer);
      }
      document.removeEventListener('click', onClick);
    };
  }, []);
  return null;
}
