/**
 * What kind of bot a user agent is, for a page's bot reads (`server/bot-views.ts`), in the order the Analytics tab
 * stacks and lists them. Each is the `bots:<source>` metric in `page_daily_counts`.
 */
export const BOT_SOURCES = ['assistant', 'ai', 'search', 'other'] as const;
export type BotSource = (typeof BOT_SOURCES)[number];

export const BOT_SOURCE_LABEL: Record<BotSource, string> = {
  assistant: 'AI assistants',
  ai: 'AI crawlers',
  search: 'Search engines',
  other: 'Other bots',
};

export const BOT_SOURCE_HINT: Record<BotSource, string> = {
  assistant: 'ChatGPT, Claude, Perplexity and others fetching the page for someone who asked',
  ai: 'GPTBot, ClaudeBot, Common Crawl and others collecting pages for AI',
  search: 'Google, Bing, Apple, DuckDuckGo and others',
  other: 'SEO tools, link previews and the rest',
};

/** Lower-cased user-agent fragments, checked in this order; anything else that says it is a bot is `other`. */
const RULES: [BotSource, string[]][] = [
  ['assistant', ['-user/', 'duckassistbot']],
  [
    'ai',
    [
      'gptbot',
      'oai-searchbot',
      'claudebot',
      'claude-searchbot',
      'anthropic-ai',
      'perplexitybot',
      'ccbot',
      'bytespider',
      'elevenlabs',
      'meta-externalagent',
      'amazonbot',
      'applebot-extended',
      'cohere',
      'diffbot',
      'youbot',
      'ai2bot',
      'exasearchbot',
      'timpibot',
      'mistralai',
      'google-cloudvertexbot',
    ],
  ],
  [
    'search',
    [
      'googlebot',
      'google-inspectiontool',
      'adsbot-google',
      'storebot-google',
      'bingbot',
      'applebot',
      'duckduckbot',
      'yandexbot',
      'baiduspider',
      'slurp',
      'seznambot',
      'petalbot',
      'qwantbot',
      'mojeekbot',
      'naver',
      'yeti/',
    ],
  ],
];

export function botSource(userAgent: string): BotSource {
  const ua = userAgent.toLowerCase();
  for (const [source, fragments] of RULES) if (fragments.some((f) => ua.includes(f))) return source;
  return 'other';
}
