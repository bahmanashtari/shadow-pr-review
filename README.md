# shadow-pr-review

AI code review that produces a narrated walkthrough video of a diff: the change is shown
and highlighted on screen while an English voiceover explains each finding.

Status: Milestones 1 to 3 are done apart from two steps waiting on decisions - a local diff
or git range goes all the way to `final.mp4` on a local model, with no API key, and `spr eval`
scores the pipeline against a golden set of nine samples. Milestone 4, GitHub integration, is
next. `docs/ROADMAP.md` has the detail, `CLAUDE.md` the working guide, and
`docs/ARCHITECTURE.md` the design.

## Requirements

- Node.js 22.22.2 or newer on the 22 line (`.nvmrc`)
- pnpm 12 through corepack 0.36 (the pnpm version comes from `package.json`; see ADR-013)
- Ollama with `qwen3:30b` pulled, for the Reviewer, Verifier and Narrator (ADR-015)
- Docker, for the Kokoro text-to-speech container (`docker/compose.yml`)
- ffmpeg and ffprobe on the PATH, and Playwright's `chromium-headless-shell`

`SPR_LLM_PROVIDER=fake` and `SPR_TTS_PROVIDER=fake` run the pipeline without a model or a
container, for the deterministic parts.

## Setup

```bash
npm install -g corepack@0.36.0
corepack enable
pnpm install
pnpm exec playwright install chromium-headless-shell
pnpm verify          # generated types, typecheck, lint, tests
```

## Try it

```bash
pnpm spr run --diff golden/sample-01-order-outbox/diff.patch   # through to final.mp4
pnpm spr run --git HEAD~1..HEAD --until verify                 # your own last commit
pnpm spr eval                                                  # score the golden set
```

## Layout

- `schemas/` stage contracts (JSON Schema, source of truth)
- `config/` default configuration and its schema
- `src/` the stages - ingest, analyzers, agents, verify, tts, director, recorder, composer - and
  `eval`
- `golden/` hand-labelled samples for evaluation, and how to contribute a real one
- `docs/` architecture, decisions, roadmap, plans, review rubric, narration style, cheat sheets
