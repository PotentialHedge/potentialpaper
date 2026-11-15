#!/usr/bin/env bash
# Builds the web editor into public/editor/vscode/<version>/: VS Code for the Web from its MIT-licensed sources
# (the Dockerfile's `vscode` stage, slow the first time and cached after), then the site's extension. The
# production image does the same in its own build (Dockerfile).
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(sed -n "s/^export const VSCODE_VERSION = '\(.*\)';/\1/p" src/editors/vscode/index.ts)
target="public/editor/vscode/$version"
if [ ! -f "$target/out/vs/code/browser/workbench/workbench.js" ] || [ "${1:-}" = "--force" ]; then
  docker build --target vscode --build-arg "VSCODE_VERSION=$version" -t "potentialpaper-vscode-web:$version" .
  rm -rf "$target" && mkdir -p "$target"
  id=$(docker create "potentialpaper-vscode-web:$version")
  docker cp "$id:/build/vscode-web/." "$target/"
  docker rm "$id" >/dev/null
fi
node scripts/build-editor-extension.mjs
