# Plan: Milestone 4, step 3 (the tool's Docker image, published to GHCR)

Status: **approved** by Bahman on 22 September 2026, every recommendation taken, and **built**
the same day (ADR-053): slim base, publish from `main` and tags only, `linux/amd64`, and a smoke
test that runs the whole pipeline inside the image. It found one defect outside the image - the
Composer depended on the installed ffmpeg's `-shortest` behaviour - which ADR-053 records.

Written straight after step 2 (ADR-052). Read CLAUDE.md, docs/ROADMAP.md,
ARCHITECTURE section 5, ADR-031 (the headless shell), ADR-033 (ffmpeg and libass) and
`docs/cheatsheets/github-integration.md` first.

## 1. What the step is

A service repository should need nothing but a workflow file: no Node, no pnpm, no Playwright
install, no apt. So the tool ships as an image on GHCR, and the workflow runs
`docker run ghcr.io/bahmanashtari/shadow-pr-review:<version> run --pr N ...` (the cheat sheet
already sketches it). Step 4 writes that workflow; this step makes the image it names, and
proves it by running the whole pipeline inside it.

## 2. What the image has to contain

`PACKAGE_ROOT` is the folder above `dist/`, and the tool reads real files from it at run time -
which is easy to get wrong, because `tsc` copies none of them:

- `config/default.json` and `config/config.schema.json` (the configuration and its schema)
- `schemas/*.schema.json` (every Ajv validator)
- `docs/REVIEW_RUBRIC.md` and `docs/NARRATION_STYLE.md` - the Reviewer's and Narrator's prompts
  are built from these two files
- `src/recorder/page/*` - browser JavaScript, CSS and HTML, deliberately outside the TypeScript
  project and inlined into `page.html` at run time (CLAUDE.md)
- `dist/`, `package.json`, and production `node_modules`

Plus, from the system: `ffmpeg` and `ffprobe` (ADR-033), and Chromium's headless shell with its
shared libraries (ADR-031). Not Kokoro: TTS is a service the container talks to over HTTP, as it
is locally.

## 3. Decisions to take

**Q1. Base image. Recommendation: `node:22-bookworm-slim`, plus apt `ffmpeg` and
`playwright install --with-deps chromium-headless-shell`.** The alternative,
`mcr.microsoft.com/playwright:v1.63.0-noble`, is the official image and needs no `--with-deps`,
but it carries three browsers and their dependencies (around 2 GB) where this tool uses one
headless shell, and it pins the Node version to whatever Microsoft ships. The slim route keeps
the pull small, which is what a per-pull-request job pays for. If `--with-deps` turns out to drag
in most of what the Playwright image has anyway, take the official image instead and say so.

**Q2. Tags and when to publish. Recommendation: build on every push and pull request, publish
only from `main` and tags.** `:edge` and `:sha-<short>` from `main`, `:vX.Y.Z` and `:latest` from
a version tag. A pull request builds the image but pushes nothing, so a broken Dockerfile fails
the pull request rather than the release.

**Q3. Architectures. Recommendation: `linux/amd64` only for now.** GitHub's hosted runners are
amd64, and so is the likeliest self-hosted Linux box. `linux/arm64` doubles build time and matters
only if the self-hosted runner ends up being an Apple Silicon machine (Q2 of step 1 left the
machine unnamed). Adding it later is one line in the build workflow.

**Q4. What the image's smoke test proves. Recommendation: the whole pipeline, with both fakes.**
`SPR_LLM_PROVIDER=fake SPR_TTS_PROVIDER=fake spr run --diff <golden sample>` inside the container
produces `final.mp4` and `comment.md` without a model or the Kokoro container, and exercises
exactly the parts of the image that can be wrong: the prompt files, the schemas, the page assets,
Chromium, and ffmpeg. It runs in the build workflow, so a broken image cannot be published.

## 4. Scope

- `docker/Dockerfile`: multi-stage. Builder installs with pnpm (frozen lockfile) and runs
  `pnpm build`; runtime copies `dist/`, `config/`, `schemas/`, the two prompt docs,
  `src/recorder/page/`, `package.json` and production `node_modules`, installs ffmpeg and the
  headless shell, runs as a non-root user, and sets `ENTRYPOINT ["node", "/app/dist/cli.js"]`
  so `docker run <image> run --pr 1 --repo o/n` reads naturally.
- `docker/.dockerignore` (or the repository's), so `runs/`, `.cache/`, `node_modules` and
  `.git` never enter the build context.
- `.github/workflows/image.yml`: buildx with layer caching, the smoke test above, then push to
  `ghcr.io/<owner>/shadow-pr-review` with `permissions: packages: write`.
- `docs/cheatsheets/github-integration.md`: the `docker run` line brought in line with the real
  entrypoint, image name and tags.
- No source changes are expected. If the image needs one - a path that only resolves in a
  checkout, say - that is a finding worth an ADR line.

## 5. What to check

- The image builds locally, and the smoke test passes inside it, before any of it is pushed.
- Image size and the smoke test's wall clock, both recorded in the ADR: they are what a service
  repository pays per pull request.
- The published image runs the same smoke test on a clean pull (`docker run --rm ghcr.io/...`),
  from the workflow.
- `pnpm verify`, `pnpm format:check`, `pnpm build` still pass.

## 6. Finish

An ADR for Q1 to Q4 with the measured size and time, the roadmap status, commit, push, CI.
