import { type PageAddress, pagePath } from './kinds';

/**
 * The tools of a page of any kind (`app/<tool>/[scheme]/[...value]`), each at its own prefix in front of the page's
 * address: `/history/abs/1706.03762`, `/history/v/iclr/2027`. They are dynamic, never cached, and kept out of indexes.
 * `versions` is a paper's only. Pure, for the server and the browser.
 */
export type Tool = 'edit' | 'code' | 'history' | 'diff' | 'claim' | 'versions';

export function toolPath(tool: Tool, address: PageAddress, query = ''): string {
  return `/${tool}${pagePath(address)}${query ? `?${query}` : ''}`;
}
