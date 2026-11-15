/**
 * PDF.js as the viewer component expects it: the library as `globalThis.pdfjsLib`, and its worker's code on the
 * page as `globalThis.pdfjsWorker`, so it parses on the page itself. A webview can't start a worker from its
 * resources (they come from another origin), and one paper at a time doesn't need one. Imported first, so this
 * runs before `pdf_viewer.mjs` reads the global.
 */
import * as pdfjsLib from 'pdfjs-dist';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';

Object.assign(globalThis, { pdfjsLib, pdfjsWorker });
