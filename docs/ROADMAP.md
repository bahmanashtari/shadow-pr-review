# Roadmap and status

The single place that says what is done and what comes next. Update the status column
in the same commit that finishes a step. Detailed plans for a step live in `docs/plans/`.

Status values: done, in progress, next, planned.

## Milestone 1: local diff to review.json and script.json

| Step | Scope | Status |
|---|---|---|
| 1 | Project setup: pnpm, strict TS, lint, vitest, CI, generated types, Ajv validators, cross-field checks, config loader, `spr validate` / `spr config` | done |
| 2 | Ingest: diff parser, filters, risk score, git range source, run folder, `ingest.json`, `HunkIndex`, `spr run --until`, `spr stage ingest`. Plan: `docs/plans/m1-step2-ingest.md` | done |
| 3 | Harness: LLM provider interface (Ollama + Anthropic + fake; per-provider context limits, ADR-015), tool-use loop with schema validation and up to 2 retries, budgets, `trace.jsonl`, `cost.json`, LLM response cache | next |
| 4 | Reviewer agent: system prompt from `docs/REVIEW_RUBRIC.md`, read-only tools (`list_changed_files`, `get_diff_hunk`, `read_file`, `grep_repo`; diff-only when there is no repo), output `review.raw.json` | planned |
| 5 | Deterministic verifier checks: lines exist (`HunkIndex.hasRange`), evidence exists (`containsSnippet`), duplicates, severity sort, cap at 10, `dropped` reasons; writes `review.json` | planned |
| 6 | Narrator agent: `script.json` from `review.json` only; code sets `focus`; word, markdown and file-name checks with retry | planned |
| 7 | `spr eval`: run the golden set, score precision and recall against `labels.json`, narration checks, print a table, write `eval.json` | planned |

Cost note: the default provider is local Ollama (ADR-015), so steps 4 to 7 cost nothing to
run and need no API key. Requires `ollama serve` on `http://localhost:11434` and the model
named in `config/default.json` pulled. To compare against a hosted model for one run:
`SPR_LLM_PROVIDER=anthropic SPR_LLM_MODEL=claude-haiku-4-5 pnpm spr run ...`, which needs
`ANTHROPIC_API_KEY` in the environment and bills separately from a Claude Pro subscription.
Keep golden runs cached.

## Milestone 2: audio and video

| Step | Scope | Status |
|---|---|---|
| 1 | `docker/compose.yml` for Kokoro-FastAPI (pinned tag); TTS provider interface, Kokoro HTTP client, fake provider; text normalization (pronunciation map); `audio/manifest.json` with durations from ffprobe; TTS cache | planned |
| 2 | Director (pure): script + manifest to `timeline.json` | planned |
| 3 | Recorder page: diff2html bundle vendored at build time, row tagging, `window.spr` API, dark theme, title and outro cards | planned |
| 4 | Recorder: Playwright executes the timeline, records `video.webm`, reports t0 | planned |
| 5 | Composer: ffmpeg concat with gaps, trim t0, merge, H.264/AAC `+faststart`, SRT (sidecar or burned), duration check | planned |
| 6 | End to end: `spr run --diff` produces `final.mp4` for all three golden samples | planned |

Needs Docker, ffmpeg and Playwright Chromium locally and in CI.

## Milestone 3: quality and robustness

| Step | Scope | Status |
|---|---|---|
| 1 | Verifier agent (keep / downgrade / drop), optional larger model for high and critical findings (cost flag) | planned |
| 2 | Prompt-injection hardening and tests (hostile comments in diffs) | planned |
| 3 | Budget and cache tuning; cost report per run | planned |
| 4 | Expand the golden set with real (anonymized) changes from the team's services | planned |

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
