import * as vscode from 'vscode';
import { formatMarkdown, formatted, problems, type CheckedFile } from './checks';

export { formatted };

/**
 * What the page's `prek.toml` does before a commit in a clone (`src/server/pages/starter.ts`), done in the web
 * editor before each commit, where there is no terminal to run prek in: on unless `potentialpaper.checks` is
 * turned off. The fixing hooks rewrite the changed files (`checks.ts`), and no commit while one has an error: a
 * checking hook's (`checks.ts`) or a JSON Schema's (VS Code's diagnostics, `/schemas/`). The site checks every
 * commit again; this catches mistakes before they are sent.
 */

/** Whether the checks run before a commit (the `potentialpaper.checks` setting). */
export function checksOn(): boolean {
  return vscode.workspace.getConfiguration('potentialpaper').get<boolean>('checks', true);
}

export interface CheckError {
  uri: vscode.Uri;
  message: string;
  range?: vscode.Range;
}

/**
 * VS Code's JSON support checks a file against its schema once the file is open. A changed file that isn't is
 * opened, and its diagnostics waited for, a moment at most.
 */
async function validated(uris: readonly vscode.Uri[]): Promise<void> {
  const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
  const waiting = new Set(uris.filter((u) => u.path.endsWith('.json') && !open.has(u.toString())).map(String));
  if (waiting.size === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, 1500);
    const listener = vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) waiting.delete(uri.toString());
      if (waiting.size === 0) done();
    });
    function done() {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    }
    for (const uri of [...waiting]) void vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  });
}

/**
 * The first error in these files: a checking hook's, then one VS Code knows of (a broken schema, bad JSON).
 * `all` is every path of the page as the commit would leave it.
 */
export async function firstError(
  files: readonly (CheckedFile & { uri: vscode.Uri })[],
  all: Iterable<string>,
): Promise<CheckError | null> {
  const problem = problems(files, all)[0];
  if (problem) {
    const file = files.find((f) => f.path === problem.path) ?? files.find((f) => f.path.startsWith(`${problem.path}/`));
    if (file) return { uri: file.uri, message: `${problem.path} ${problem.message}` };
  }
  const uris = files.map((f) => f.uri);
  await validated(uris);
  for (const uri of uris) {
    const diagnostic = vscode.languages.getDiagnostics(uri).find((d) => d.severity === vscode.DiagnosticSeverity.Error);
    if (diagnostic) return { uri, range: diagnostic.range, message: diagnostic.message };
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
