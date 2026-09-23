# The tool as one image, so a service repository needs nothing but a workflow file (ADR-053).
#
#   docker build -f docker/Dockerfile -t shadow-pr-review .
#   docker run --rm -v "$PWD:/repo" ghcr.io/<owner>/shadow-pr-review:<tag> run --pr 1 --repo o/n
#
# Debian slim plus exactly two system dependencies - ffmpeg (ADR-033) and Chromium's headless
# shell (ADR-031) - rather than the official Playwright image, which carries three browsers.
# Kokoro is not in here: TTS is an HTTP service this container talks to, as it is locally.
FROM node:22-bookworm-slim AS builder

# The bundled corepack can be too old for pnpm 12 (ADR-013).
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /build

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# A second tree with only what the tool needs at run time.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts


FROM node:22-bookworm-slim AS runtime

# Where Playwright keeps the browser, outside any user's home so every user can read it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY package.json ./
COPY config ./config
COPY schemas ./schemas
# The Reviewer's and Narrator's prompts are built from these two files at run time.
COPY docs/REVIEW_RUBRIC.md docs/NARRATION_STYLE.md ./docs/
# Browser JavaScript, inlined into page.html at run time and deliberately not compiled.
COPY src/recorder/page ./src/recorder/page

# ffmpeg and ffprobe for the Composer; the Debian package is built with libass, so burned-in
# subtitles work here (ADR-033). git because `--git` shells out to it, and because `checkoutAt`
# asks git whether the working directory is the reviewed head - without it the repository tools
# are withheld in every container, silently (ADR-056). Then the headless shell and its libraries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git \
    && node node_modules/playwright/cli.js install --with-deps chromium-headless-shell \
    && apt-get purge -y --auto-remove \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright

# git refuses to work in a repository it sees as owned by somebody else, and the mounted
# checkout's owner depends on the host and on the --user the caller passes. Inside this
# container the mount is exactly the repository the caller asked to review, and every git
# command the tool runs is read-only, so the check protects nothing here (ADR-056).
ENV GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*

# The pipeline writes its run folder and cache under the working directory, which a workflow
# mounts. Nothing needs root, so nothing runs as root.
RUN mkdir -p /repo && chown node:node /repo
USER node
WORKDIR /repo

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
