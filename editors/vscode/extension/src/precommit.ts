import * as markdownPlugin from 'prettier/plugins/markdown';
import * as prettier from 'prettier/standalone';
import * as vscode from 'vscode';

/**
 * What the page's `prek.toml` does before a commit in a clone (`src/server/pages/starter.ts`), done here before a
 * commit from the web editor: sections formatted with the same Prettier, JSON laid out as the site writes it, and
 * no commit while a changed file has an error (a JSON file that breaks its schema, `/schemas/`). The site checks
 * every commit again; this catches mistakes before they are sent.
 */

const SECTION = /^(author|community)\/[^/]+\.md$/;

/** A section as Prettier formats Markdown, with its defaults, as the hook runs it. */
export function formatMarkdown(text: string): Promise<string> {
  return prettier.format(text, { parser: 'markdown', plugins: [markdownPlugin] });
}

/** JSON as `pretty-format-json --no-sort-keys` writes it, which is how the site writes it too; `null` if it isn't JSON. */
function formatJson(text: string): string | null {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return null;
  }
}

/** The file formatted as the hooks would leave it, or `null` to leave it as it is. */
export async function formatted(path: string, text: string): Promise<string | null> {
  if (SECTION.test(path)) {
    if (text.trim() === '') return null;
    const out = await formatMarkdown(text);
    return out === text ? null : out;
  }
  if (path.endsWith('.json') && !path.startsWith('demos/')) {
    const out = formatJson(text);
    return out === null || out === text ? null : out;
  }
  return null;
}

/** The first error VS Code knows of in these files: a broken schema, bad JSON. */
export function firstError(uris: readonly vscode.Uri[]): { uri: vscode.Uri; diagnostic: vscode.Diagnostic } | null {
  for (const uri of uris) {
    const diagnostic = vscode.languages.getDiagnostics(uri).find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    if (diagnostic) return { uri, diagnostic };
  }
  return null;
}

/** The section formatter, for Format Document. */
export function markdownFormatter(): vscode.DocumentFormattingEditProvider {
  return {
    async provideDocumentFormattingEdits(document) {
      const text = document.getText();
      const out = await formatMarkdown(text);
      if (out === text) return [];
      return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), out)];
    },
  };
}
