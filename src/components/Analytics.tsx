'use client';

import { useEffect } from 'react';
import { analyticsUrl, UMAMI_DOMAIN, UMAMI_SCRIPT, UMAMI_WEBSITE_ID } from '@/lib/analytics';

const BEFORE_SEND = 'potentialPaperBeforeSend';

type Payload = { url?: string; referrer?: string; [key: string]: unknown };

/**
 * The Umami tracker: page views (client-side navigations included), Core Web Vitals, and uncaught JavaScript errors
 * (Umami 3.5's error tracking: each with its message and stack, grouped into issues). Cookieless; it
 * never learns who the viewer is. Every hit passes through `analyticsUrl` first, and the hook must exist
 * before the tracker's first page view, so it is installed here and only then is the script added — never
 * a plain <script> in the layout, which could run first.
 */
export function Analytics() {
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w[BEFORE_SEND] = (_type: string, payload: Payload) => {
      const origin = window.location.origin;
      return {
        ...payload,
        url: payload.url && analyticsUrl(payload.url, origin),
        referrer: payload.referrer && analyticsUrl(payload.referrer, origin),
      };
    };
    if (document.querySelector('script[data-website-id]')) return;
    const script = document.createElement('script');
    script.defer = true;
    script.src = UMAMI_SCRIPT;
    script.dataset.websiteId = UMAMI_WEBSITE_ID;
    script.dataset.beforeSend = BEFORE_SEND;
    script.dataset.domains = UMAMI_DOMAIN;
    script.dataset.excludeHash = 'true';
    script.dataset.performance = 'true';
    script.dataset.errors = 'true';
    document.head.appendChild(script);
  }, []);
  return null;
}
