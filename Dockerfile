# Two targets from one build:
#
#   app    the Next.js standalone server (~200 MB). What runs behind Traefik.
#   tools  full dependencies + source, for the tsx scripts that are not part of
#          the server: migrations, users:prune, and the PDF ingest pipeline
#          (the `ingest` service), which needs poppler. Run one-off with
#          `docker compose run --rm tools npm run <script>`.

# VS Code for the Web, built from the MIT-licensed sources (microsoft/vscode) at the tag in
# src/editors/vscode/index.ts: the web editor (docs/web-editor.md). Static files, in /build/vscode-web. Slow the first
# time (~15 min); Docker keeps the stage while the version stays the same. Trixie, for a compiler new enough for
# the native modules its install builds (unused on the web, but npm ci builds them).
FROM node:24.22.1-trixie AS vscode
ARG VSCODE_VERSION=1.145.3
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 make g++ pkg-config libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev jq \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 --branch "${VSCODE_VERSION}" https://github.com/microsoft/vscode.git vscode
WORKDIR /build/vscode
# No extensions from the marketplace (js-debug and the like download at build time), and none to download later.
RUN jq 'del(.builtInExtensions) | del(.extensionsGallery) | .enableTelemetry = false' product.json > p.json && mv p.json product.json
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 VSCODE_SKIP_NODE_VERSION_CHECK=1
RUN npm ci
# Our trims: no terminal, debugging, sign-in or notebooks (editors/vscode/patch-vscode.mjs).
COPY editors/vscode/patch-vscode.mjs /build/patch-vscode.mjs
RUN node /build/patch-vscode.mjs /build/vscode
RUN npm run gulp core-ci
RUN npm run gulp vscode-web-min-ci

FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*
COPY . .
ENV NODE_ENV=production
CMD ["npm", "run", "db:migrate"]

FROM deps AS build
ARG VSCODE_VERSION=1.145.3
COPY . .
COPY --from=vscode /build/vscode-web public/editor/vscode/${VSCODE_VERSION}
RUN test -n "$(grep -F "VSCODE_VERSION = '${VSCODE_VERSION}'" src/editors/vscode/index.ts)" \
 && npm run editor:extension
ENV NEXT_TELEMETRY_DISABLED=1
# The cache mount keeps Next's compiler cache between builds: with one shared core
# the compile is nearly all of a deploy's time, and most modules do not change.
RUN --mount=type=cache,target=/app/.next/cache npm run build

FROM node:26-bookworm-slim AS app
# The commit this image was built from (docker-compose.prod.yml passes it): `docker inspect` shows it, and
# `GET /api/v1/version` reports it. The build context has no .git, so it can only come from the build.
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.revision=$GIT_COMMIT
WORKDIR /app
ENV GIT_COMMIT=$GIT_COMMIT \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Read at runtime from the working directory (INSTITUTION_DOMAINS_PATH overrides).
COPY --chown=node:node config ./config
USER node
EXPOSE 3000
CMD ["node", "server.js"]
