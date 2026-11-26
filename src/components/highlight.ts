'use client';

import type { HLJSApi } from 'highlight.js';
import { type RefObject, useEffect } from 'react';

/**
 * Syntax highlighting for code shown in the browser (the Repo tab's files and their Markdown's code blocks), with
 * highlight.js: only its core and the few languages page repos hold, loaded the first time a code block is on screen,
 * so no page pays for it otherwise. The colours are the site's (`.hljs-*`, `globals.css`).
 */

let loading: Promise<HLJSApi> | null = null;

function load(): Promise<HLJSApi> {
  loading ??= (async () => {
    const [core, json, ini, xml, markdown, javascript, css, yaml, bash, python, plaintext] = await Promise.all([
      import('highlight.js/lib/core'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/ini'),
      import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/python'),
      import('highlight.js/lib/languages/plaintext'),
    ]);
    const hljs = core.default;
    const languages = { json, ini, xml, markdown, javascript, css, yaml, bash, python, plaintext };
    for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language.default);
    hljs.registerAliases(['toml'], { languageName: 'ini' });
    hljs.registerAliases(['jsonl'], { languageName: 'json' });
    hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });
    return hljs;
  })();
  return loading;
}

/** The language of a file by its name, as a `language-*` class names it; `plaintext` for any other. */
export function languageOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const byExt: Record<string, string> = {
    json: 'json',
    jsonl: 'json',
    toml: 'ini',
    html: 'xml',
    htm: 'xml',
    svg: 'xml',
    md: 'markdown',
    js: 'javascript',
    mjs: 'javascript',
    ts: 'javascript',
    css: 'css',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    py: 'python',
  };
  return byExt[ext] ?? 'plaintext';
}

/** Highlights the code blocks (`pre code.language-*`) under `ref` each time `key` changes. */
export function useHighlight(ref: RefObject<HTMLElement | null>, key: unknown): void {
  useEffect(() => {
    const blocks = ref.current?.querySelectorAll<HTMLElement>('pre code[class*="language-"]');
    if (!blocks || blocks.length === 0) return;
    let live = true;
    load().then(
      (hljs) => {
        if (!live) return;
        for (const block of blocks) {
          const language = /\blanguage-(\S+)/.exec(block.className)?.[1];
          if (block.dataset.highlighted || !language || !hljs.getLanguage(language)) continue;
          hljs.highlightElement(block);
        }
      },
      // Unhighlighted code is still code.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [ref, key]);
}
