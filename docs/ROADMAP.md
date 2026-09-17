# Roadmap and status

The single place that says what is done and what comes next. Update the status column
in the same commit that finishes a step. Detailed plans for a step live in `docs/plans/`.

Status values: done, in progress, next, planned.

## Milestone 1: local diff to review.json and script.json

| Step | Scope | Status |
|---|---|---|
| 1 | Project setup: pnpm, strict TS, lint, vitest, CI, generated types, Ajv validators, cross-field checks, config loader, `spr validate` / `spr config` | done |
| 2 | Ingest: diff parser, filters, risk score, git range source, run folder, `ingest.json`, `HunkIndex`, `spr run --until`, `spr stage ingest`. Plan: `docs/plans/m1-step2-ingest.md` | done |
| 3 | Harness: LLM provider interface (Ollama + Anthropic + fake; per-provider context limits, ADR-015), tool-use loop with schema validation and up to 2 retries, budgets, `trace.jsonl`, `cost.json`, LLM response cache. Plan: `docs/plans/m1-step3-harness.md` | done |
| 4 | Analyzers (deterministic findings from the diff, ADR-022) then the Reviewer agent: prompt from `docs/REVIEW_RUBRIC.md`, line-numbered diff, read-only tools, output `review.raw.json`. Plan: `docs/plans/m1-step4-reviewer.md` | done |
| 5 | Deterministic verifier checks: lines exist (`HunkIndex.hasRange`), evidence exists (`containsSnippet`), duplicates, severity sort, cap at 10, `dropped` reasons; writes `review.json`. Plan: `docs/plans/m1-step5-verifier.md` | done |
| 6 | Narrator agent: `script.json` from `review.json` only; code sets `focus`; word, markdown and file-name checks with retry. Plan: `docs/plans/m1-step6-narrator.md` | done |
| 7 | `spr eval`: run the golden set, score precision and recall against `labels.json`, narration checks, print a table, write `eval.json`. Plan: `docs/plans/m1-step7-eval.md` | done |

Cost note: the default provider is local Ollama (ADR-015), so steps 4 to 7 cost nothing to
run and need no API key. Requires `ollama serve` on `http://localhost:11434` and the model
named in `config/default.json` pulled. To compare against a hosted model for one run:
`SPR_LLM_PROVIDER=anthropic SPR_LLM_MODEL=claude-opus-5 pnpm spr run ...`, which needs
`ANTHROPIC_API_KEY` in the environment and bills separately from a Claude Pro subscription.
That path is opt-in only: the pipeline must keep working, and reviewing well, with no key at
all. Model output is cached on disk across runs (ADR-017), so repeating the golden set is free.

Milestone 1 is complete: `spr run --diff <patch> --until narrate` produces a grounded
`review.json` and a spoken `script.json` from a local model, and `spr eval` scores the whole
of it against the golden set.

## Milestone 2: audio and video

| Step | Scope | Status |
|---|---|---|
| 1 | `docker/compose.yml` for Kokoro-FastAPI (pinned tag); TTS provider interface, Kokoro HTTP client, fake provider; text normalization (pronunciation map); `audio/manifest.json` with durations read from the WAV header, not ffprobe; TTS cache. Narration length measured against real audio (ADR-027, ADR-028). Plan: `docs/plans/m2-step1-tts.md` | done |
| 2 | Director (pure): script + manifest to `timeline.json`, with the lead-in clamped so it never precedes the previous step. Plan: `docs/plans/m2-step2-director.md` | done |
| 3 | Recorder page: diff2html inlined into one self-contained file, row tagging, `window.spr` API, dark theme, title and outro cards. Plan: `docs/plans/m2-step3-recorder-page.md` | done |
| 4 | Recorder: Playwright executes the timeline, records `video.webm`, reports t0 in `record.json` (ADR-031, ADR-032). Plan: `docs/plans/m2-step4-recorder.md` | done |
| 5 | Composer: ffmpeg concat with gaps, trim t0, merge, H.264/AAC `+faststart`, SRT (sidecar or burned), duration check (ADR-033). Plan: `docs/plans/m2-step5-composer.md` | done |
| 6 | End to end: `spr run --diff` produces `final.mp4` for all three golden samples | next |

Needs Docker for step 1, Playwright's headless shell from step 4, and ffmpeg from step 5.
Steps 1 to 4 deliberately need neither ffmpeg nor ffprobe (ADR-027, ADR-031): Playwright brings
its own ffmpeg for the WebM, so the real one is a step 5 dependency. `SPR_TTS_PROVIDER=fake`
runs the audio side without Docker, and the browser-backed test skips itself when no Chromium
is installed.

## Milestone 3: quality and robustness

| Step | Scope | Status |
|---|---|---|
| 1 | Verifier agent (keep / downgrade / drop), optional larger model for high and critical findings (cost flag) | planned |
| 2 | Prompt-injection hardening and tests (hostile comments in diffs) | planned |
| 3 | Budget and cache tuning; cost report per run | planned |
| 4 | Expand the golden set with real (anonymized) changes from the team's services. **Blocker for any further model comparison**: three of four local models now tie at 1.000 precision and recall on the current three samples (ADR-026) | planned |
| 5 | Repo-aware static analysis feeding `src/analyzers/` (ADR-022): `tsc` for floating promises and unsafe casts, `eslint` with the reviewed repository's own config, `dependency-cruiser` for the cross-file layer graph. Needs a checkout with dependencies installed, so it is skipped when a run has none, and it means executing the reviewed repository's toolchain - decide the sandboxing story first | planned |
| 6 | Narration length: give the Narrator a per-step target band instead of only a cap, and restate the whole-video line in `docs/NARRATION_STYLE.md`, which the measurement falsified. The cause is pinned to one sentence in `HOW_TO_ANSWER` (`src/agents/prompts/narrator.ts`): "Those are hard limits, not targets." Both files feed the prompt, so it is one change, and it needs a `spr eval` run behind it because it moves ADR-026's baseline (ADR-028). **Re-measure before acting**: the numbers in ADR-028 predate ADR-029, and deduplicating the analyzer findings moved finding steps from 26-33 words to 39 against the fixtures' 44-60, closing more than half the gap without touching the prompt | planned |
| 7 | Score redundancy in `spr eval`: nothing in `src/eval/score.ts` can see two kept findings making the same claim, because every metric scores findings one at a time - `sample-01` scored 1.000/1.000 both with and without a duplicate (ADR-029). Wants its own axis, in the shape ADR-025 gave restraint | planned |

## Milestone 4: GitHub integration

| Step | Scope | Status |
|---|---|---|
| 1 | `--pr` source via Octokit (same ingest outputs as `--git`) | planned |
| 2 | `spr publish`: sticky PR comment, optional commit comment for pushes | planned |
| 3 | Tool Docker image (Playwright Node base + ffmpeg), published to GHCR | planned |
| 4 | Workflow for service repos (see `docs/cheatsheets/github-integration.md`), trigger policy from ARCHITECTURE.md section 3, fork and draft handling | planned |
| 5 | Video hosting: Actions artifact first; object storage later (ADR-008) | planned |

## Milestone 5: polish

Subtitles styling, intro and outro cards, voice and theme options, docs for service teams,
composite or reusable workflow.

## How to work on a step

1. Read CLAUDE.md, this file, and the relevant docs and ADRs.
2. If there is no plan in `docs/plans/` for the step, write one (scope, files, contracts,
   tests, open questions) and get it approved before writing code.
3. Implement inside the step's scope. Contract changes follow CLAUDE.md (schema, generated
   types, fixtures, ADR together).
4. `pnpm verify`, `pnpm format:check` and `pnpm build` pass; CI is green after push.
5. Update the status here, and add an ADR for any decision with lasting effect.
