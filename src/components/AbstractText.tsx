import { renderSourceText } from '@/server/comments/render';

/**
 * Text set as a paper's abstract is (a paper's abstract, a person's bio): its Markdown and TeX rendered, with
 * "Abstract." run into its first paragraph. Server-only, as the renderer is.
 */
export function AbstractText({ text, className = '' }: { text: string; className?: string }) {
  const html = renderSourceText(text);
  const label = '<b>Abstract.</b> ';
  return (
    <div
      className={`md break-words ${className}`}
      dangerouslySetInnerHTML={{ __html: html.startsWith('<p>') ? `<p>${label}${html.slice(3)}` : label + html }}
    />
  );
}
