/** A Markdown answer for an agent, as `/llms.txt` and `/agent/*` send. */
export function markdown(body: string, { cache = 'public, max-age=300', status = 200 } = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': cache },
  });
}
