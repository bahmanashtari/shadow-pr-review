# shadow-pr-review

AI code review that produces a narrated walkthrough video of a diff: the change is shown
and highlighted on screen while an English voiceover explains each finding.

Status: Milestone 1, step 1 (project setup, contracts, validation). See `CLAUDE.md` for
the working guide and `docs/ARCHITECTURE.md` for the design.

## Requirements

- Node.js 22.13 or newer (`.nvmrc`)
- pnpm 12 (enable with `corepack enable`; the version comes from `package.json`)
- Later milestones: Docker (Kokoro TTS), ffmpeg, Playwright Chromium

## Setup

```bash
corepack enable
pnpm install
pnpm verify          # generated types, typecheck, lint, tests
```

## Try it

```bash
pnpm spr validate golden/*/review.expected.json golden/*/script.expected.json
pnpm spr config
```

## Layout

- `schemas/` stage contracts (JSON Schema, source of truth)
- `config/` default configuration and its schema
- `src/contracts/` generated types, Ajv validators, cross-field checks
- `golden/` hand-labelled samples for evaluation
- `docs/` architecture, decisions, review rubric, narration style, cheat sheets
