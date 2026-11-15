import './pdfjs-globals';
import { getDocument } from 'pdfjs-dist';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';

/**
 * The PDF viewer's page (`src/pdf.ts`): PDF.js's own viewer component, every page in one scroll, with selectable
 * text and working links, fitted to the width. The extension sends the bytes; zoom comes from the editor's title.
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type Message =
  | { type: 'pdf'; bytes: Uint8Array; name: string }
  | { type: 'problem'; text: string }
  | { type: 'zoom'; by: 'in' | 'out' | 'width' };

const vscode = acquireVsCodeApi();
const base = new URL(`${document.body.dataset.base ?? ''}/`.replace(/\/+$/, '/'));
const container = document.getElementById('viewerContainer') as HTMLDivElement;
const note = document.getElementById('note') as HTMLParagraphElement;
const pages = document.getElementById('pages') as HTMLSpanElement;
const zoom = document.getElementById('zoom') as HTMLSpanElement;

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 /* LinkTarget.BLANK */ });
const viewer = new PDFViewer({ container, eventBus, linkService, removePageBorders: false });
linkService.setViewer(viewer);

eventBus.on('pagesinit', () => {
  viewer.currentScaleValue = 'page-width';
});
eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
  pages.textContent = `${pageNumber} / ${viewer.pagesCount}`;
});
eventBus.on('scalechanging', ({ scale }: { scale: number }) => {
  zoom.textContent = `${Math.round(scale * 100)}%`;
});

// The width follows the panel's, until someone zooms.
let fitted = true;
new ResizeObserver(() => {
  if (fitted && viewer.pagesCount) viewer.currentScaleValue = 'page-width';
}).observe(container);

container.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    fitted = false;
    if (event.deltaY < 0) viewer.increaseScale();
    else viewer.decreaseScale();
  },
  { passive: false },
);

// Links in the paper open in the browser.
container.addEventListener('click', (event) => {
  const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link || link.getAttribute('href')?.startsWith('#')) return;
  event.preventDefault();
  vscode.postMessage({ type: 'link', href: link.href });
});

async function open(bytes: Uint8Array, name: string) {
  try {
    const pdf = await getDocument({
      data: bytes,
      cMapUrl: new URL('cmaps/', base).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', base).href,
      wasmUrl: new URL('wasm/', base).href,
      iccUrl: new URL('iccs/', base).href,
    }).promise;
    document.title = name;
    viewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
    pages.textContent = `1 / ${pdf.numPages}`;
  } catch (err) {
    note.hidden = false;
    note.textContent = `${name} could not be shown: ${err instanceof Error ? err.message : String(err)}`;
  }
}

window.addEventListener('message', (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === 'pdf') void open(message.bytes, message.name);
  if (message.type === 'problem') {
    note.hidden = false;
    note.textContent = message.text;
  }
  if (message.type === 'zoom') {
    if (message.by === 'width') {
      fitted = true;
      viewer.currentScaleValue = 'page-width';
    } else {
      fitted = false;
      if (message.by === 'in') viewer.increaseScale();
      else viewer.decreaseScale();
    }
  }
});

vscode.postMessage({ type: 'ready' });
