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
| 6 | End to end: `spr run --diff` produces `final.mp4` for all three golden samples, via `scripts/end-to-end.ts`. The bare `spr run` path had no unit coverage since step 4 made recording real-time, and this is where it is exercised again (ADR-034). Plan: `docs/plans/m2-step6-end-to-end.md` | done |

Milestone 2 is complete: `spr run --diff <patch>` walks ingest to compose unattended and
produces a watchable `final.mp4`, and all three golden samples do so in 2:25 of wall clock with
a warm cache. `pnpm tsx scripts/end-to-end.ts` is the deliberate re-run. What the first complete
run found is ADR-034, including one real defect it hands to Milestone 3: the Composer's sync
check cannot detect a truncated recording, because `-shortest` equalises the two streams it
compares.

Needs Docker for step 1, Playwright's headless shell from step 4, and ffmpeg from step 5.
Steps 1 to 4 deliberately need neither ffmpeg nor ffprobe (ADR-027, ADR-031): Playwright brings
its own ffmpeg for the WebM, so the real one is a step 5 dependency. `SPR_TTS_PROVIDER=fake`
runs the audio side without Docker, and the browser-backed test skips itself when no Chromium
is installed.

## Milestone 3: quality and robustness

Steps 8 to 10 came out of the first complete run (ADR-034) and are numbered after the original
seven rather than inserted among them, so nothing that already points at a step number moves.
Step 8 was taken first, ahead of step 1, because it was a defect rather than an improvement -
the pipeline could ship a video with the end of the narration cut off and report the best sync
figure the project had recorded. That is fixed (ADR-035), so step 1 has the "next" marker back.
Steps 9 and 10 are the other two the end-to-end run turned up and are ready to pick up in any
order; 9 is a prompt change and pairs naturally with step 6.

| Step | Scope | Status |
|---|---|---|
| 1 | Verifier agent (keep / downgrade / drop). **Read the plan before starting**: the agent is additive within the existing contract, but nothing in `spr eval` can currently tell whether it helped - precision and recall are already 1.000 (ADR-026), and over-rating severity is free by construction, so the step needs a calibration axis before it can be judged. Plan: `docs/plans/m3-step1-verifier-agent.md` | next |
| 2 | Prompt-injection hardening and tests (hostile comments in diffs) | planned |
| 3 | Budget and cache tuning; cost report per run | planned |
| 4 | Expand the golden set with real (anonymized) changes from the team's services. **Blocker for any further model comparison**: three of four local models now tie at 1.000 precision and recall on the current three samples (ADR-026) | planned |
| 5 | Repo-aware static analysis feeding `src/analyzers/` (ADR-022): `tsc` for floating promises and unsafe casts, `eslint` with the reviewed repository's own config, `dependency-cruiser` for the cross-file layer graph. Needs a checkout with dependencies installed, so it is skipped when a run has none, and it means executing the reviewed repository's toolchain - decide the sandboxing story first | planned |
| 6 | Narration length: give the Narrator a per-step target band instead of only a cap, and restate the whole-video line in `docs/NARRATION_STYLE.md`, which the measurement falsified. The cause is pinned to one sentence in `HOW_TO_ANSWER` (`src/agents/prompts/narrator.ts`): "Those are hard limits, not targets." Both files feed the prompt, so it is one change, and it needs a `spr eval` run behind it because it moves ADR-026's baseline (ADR-028). **Re-measured in ADR-034**: finding steps now mean 33.7 words against the fixtures' 44.6, so the gap narrowed by half and did not close, and the decision stands. ADR-034 also supersedes ADR-028's speaking rate (2.5 w/s is right, not 2.35) and adds the argument that the one length rule written as a band is the one the model obeys | planned |
| 7 | Score redundancy in `spr eval`: nothing in `src/eval/score.ts` can see two kept findings making the same claim, because every metric scores findings one at a time - `sample-01` scored 1.000/1.000 both with and without a duplicate (ADR-029). Wants its own axis, in the shape ADR-025 gave restraint - and the calibration axis added in step 1 (ADR-036) is now a worked example of that shape to copy | planned |
| 8 | **The Composer's sync check was vacuous, and a short recording went unnoticed.** `assertInSync` compares the final file's two streams, which `-shortest` has already forced into agreement, so it can only ever measure frame granularity - it passed a `final.mp4` whose narration was cut off 429 ms early at "8 ms apart". Compare the final audio against `timeline.total_duration_ms` instead, and check `record.json`'s `recorded_duration_ms` against the webm's real duration, which was 678 ms shorter on the run that failed. Done: three checks, each against a reference the encode cannot move, and the run that failed now fails (ADR-035). Plan: `docs/plans/m3-step8-sync-check.md` | done |
| 9 | **The narration says "critical" where the outro card says "high".** The Narrator takes the word from the Reviewer's `summary` prose, which opens "Critical ..." on all three samples, rather than from the `severity` field the card counts. Two of three videos contradict themselves out loud (ADR-034). A prompt change, so it needs `spr eval` behind it (ADR-025) and belongs with step 6 | planned |
| 10 | **Orphan subtitle cues.** `cuesForStep` divides a step's window between cue groups by character count, which is right arithmetic and flashes a trailing half-group on screen for 415 ms ("layer."). Wants a minimum cue duration, borrowing time from the group before it, or a split that balances groups rather than filling them (ADR-034) | planned |

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
