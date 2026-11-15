import type { WebEditor } from './types';
import { vscodeEditor } from './vscode';

export type { WebEditor } from './types';

/** The site's web editor. To change it, add another `WebEditor` beside `./vscode` and name it here. */
export const webEditor: WebEditor = vscodeEditor;
