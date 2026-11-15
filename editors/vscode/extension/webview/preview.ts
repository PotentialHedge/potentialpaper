/**
 * The preview panel's page (`src/preview.ts`): the section's HTML from the site, put in place block by block, and
 * the demos in it run as the paper's page runs them (`src/components/paper/DemoFrames.tsx`, in short).
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type Message =
  | { type: 'html'; path: string; html: string }
  | { type: 'problem'; path: string | null; text: string; signIn: boolean }
  | { type: 'empty' };

const vscode = acquireVsCodeApi();
const page = document.getElementById('page') as HTMLElement;
const note = document.getElementById('note') as HTMLElement;

/** The HTML each kept node was made from, since a frame's own attributes change once it runs. */
const sourceOf = new WeakMap<Node, string>();
const htmlOf = (node: Node) => (node instanceof Element ? node.outerHTML : (node.textContent ?? ''));

/** Replaces only the top-level blocks that changed (`src/components/editor/PreviewHtml.tsx`). */
function patch(into: HTMLElement, html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const next = [...template.content.childNodes];
  for (const node of next) sourceOf.set(node, htmlOf(node));
  const old = [...into.childNodes];
  const same = (a: Node, b: Node) => sourceOf.get(a) === sourceOf.get(b);
  let start = 0;
  while (start < old.length && start < next.length && same(old[start], next[start])) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    same(old[old.length - 1 - end], next[next.length - 1 - end])
  )
    end++;
  const anchor = old[old.length - end] ?? null;
  for (const node of old.slice(start, old.length - end)) node.remove();
  for (const node of next.slice(start, next.length - end)) into.insertBefore(node, anchor);
}

// Demos: each frame loads once it comes near the screen, and takes the height its page reports
// (`DEMO_HEIGHT_MESSAGE` and the limits in `src/lib/demos.ts`).
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

function watchDemos() {
  for (const frame of page.querySelectorAll<HTMLIFrameElement>('iframe.demo-frame[data-src]')) {
    if (!frame.src) observer.observe(frame);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as (Message & { height?: unknown }) | { type?: unknown; height?: unknown } | null;
  if (event.source && event.source !== window && event.source !== window.parent) {
    // From a demo's frame.
    if (data?.type !== 'potentialpaper:demo-height' || typeof data.height !== 'number') return;
    const frame = [...page.querySelectorAll<HTMLIFrameElement>('iframe.demo-frame')].find(
      (f) => f.contentWindow === event.source,
    );
    if (!frame || new URL(frame.src).origin !== event.origin) return;
    const height = Math.round(Math.min(4000, data.height));
    if (height < 120) return;
    frame.style.height = `${height}px`;
    frame.classList.add('demo-sized');
    return;
  }
  const message = data as Message;
  if (message.type === 'html') {
    note.textContent = '';
    note.hidden = true;
    patch(page, message.html);
    watchDemos();
  } else if (message.type === 'problem') {
    note.hidden = false;
    note.replaceChildren(message.text);
    if (message.signIn) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Sign in';
      button.addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));
      note.append(' ', button);
    }
  } else if (message.type === 'empty') {
    note.hidden = false;
    note.textContent = 'Open a section in community/ or author/ to see it here as the page will show it.';
  }
});

document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest?.('[data-demo-fullscreen]');
  if (!button) return;
  const frame = button.closest('figure.demo')?.querySelector<HTMLIFrameElement>('iframe.demo-frame');
  if (!frame) return;
  if (!frame.src && frame.dataset.src) frame.src = frame.dataset.src;
  void frame.requestFullscreen?.();
});

vscode.postMessage({ type: 'ready' });
