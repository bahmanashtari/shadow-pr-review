# shadow-pr-review

AI code review that produces a narrated walkthrough video of a diff: the change is shown and
highlighted on screen while an English voiceover explains each finding, and a sticky comment on
the pull request carries the same findings as text.

It runs on a local model and needs no API key. A review costs electricity and CI minutes.

**Status: complete and measured, not proven.** Every stage runs - a pull request, a local git
range or a patch file goes all the way to `final.mp4` and a posted comment - and the tool has
reviewed and commented on a real pull request through the GitHub API. Its scores come from nine
hand-labelled samples that were written for it to find: precision 1.000, recall 0.750 on the
default model, with no false positives on that set. The one real pull request it has reviewed
produced two false positives and found nothing, which is the honest headline (ADR-060, ADR-061).
`docs/ROADMAP.md` has what was built, `docs/DECISIONS.md` why, `CLAUDE.md` the working guide.

## What a reviewer sees

A comment that opens with what was found and links a video, then a table of findings - each
linked to the exact lines at the reviewed commit - and each finding's reasoning and suggested fix
in a collapsed section. The video spends every second on the findings: one step per finding, no
intro, no outro, and no video at all when nothing was found (ADR-042).

**Adding it to a service repository is ten lines of workflow**: see
[docs/SERVICE_TEAM_GUIDE.md](docs/SERVICE_TEAM_GUIDE.md).

## How it works

```
ingest -> review -> verify -> narrate -> tts -> direct -> record -> compose -> publish
```

Nine stages, each reading the previous one's file from the run folder and writing its own, so any
stage can be re-run alone (`spr stage <name> --run runs/<id>`). Three of them call a model -
Reviewer, Verifier, Narrator - and everything else is plain code (ADR-002). The script is written
before anything is rendered, and the video's timing comes from the measured audio, not the other
way round (ADR-001).

Two rules shape the output. **Every finding must quote real lines of the diff**: the Verifier
drops one that cannot be grounded, that sits on unchanged context, or whose evidence is all
comments and no code (ADR-058). And **the tool reads a repository and never runs it** - no build,
no tests, no `tsc`, nothing from a pull request is ever executed (ADR-062).

## Requirements

- Node.js 22.22.2 or newer on the 22 line (`.nvmrc`)
- pnpm 12 through corepack 0.36 (the pnpm version comes from `package.json`; see ADR-013)
- Ollama with `qwen3:30b` pulled, for the Reviewer, Verifier and Narrator (ADR-015)
- Docker, for the Kokoro text-to-speech container (`docker/compose.yml`)
- ffmpeg and ffprobe on the PATH, and Playwright's `chromium-headless-shell`

`SPR_LLM_PROVIDER=fake` and `SPR_TTS_PROVIDER=fake` run the pipeline without a model or a
container, for the deterministic parts. A service repository needs none of this: it runs the
published image (`ghcr.io/bahmanashtari/shadow-pr-review`).

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
pnpm spr run --pr 142 --repo owner/name                        # a GitHub pull request
pnpm spr eval                                                  # score the golden set
pnpm spr eval --seed 1 --seed 2 --seed 3                       # the spread, not one point
```

`spr run` never posts. Posting is `spr stage publish --run runs/<id>`, a command of its own,
because it is the only thing this tool does that other people see (ADR-052).

## Layout

- `schemas/` stage contracts (JSON Schema, source of truth)
- `config/` default configuration and its schema
- `src/` the stages - ingest, analyzers, agents, verify, tts, director, recorder, composer,
  publish - and `eval`
- `golden/` hand-labelled samples for evaluation, and how to contribute a real one
- `docker/` the tool's image and the Kokoro compose file
- `.github/workflows/` CI, the image build, and the reusable review workflow
- `docs/` architecture, decisions, roadmap, plans, review rubric, narration style, cheat sheets
