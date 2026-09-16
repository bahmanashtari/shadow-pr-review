# Architecture

## 1. Overview

```
 GitHub event / local git
          |
     [1 Ingest] ------------------------------> diff.raw.patch, diff.patch, ingest.json
          |
     [2 Analyzers (code) + Reviewer agent] ---> review.raw.json
          |
     [3 Verifier agent + deterministic checks] -> review.json
          |
     [4 Narrator agent] ----------------------> script.json
          |
     [5 TTS: Kokoro over HTTP] ---------------> audio/*.wav, audio/manifest.json
          |
     [6 Director (pure code)] ----------------> timeline.json
          |
     [7 Recorder: Playwright + diff2html] ----> video.webm (+ t0 offset)
          |
     [8 Composer: ffmpeg] --------------------> subtitles.srt, final.mp4
          |
     [9 Publish] -----------------------------> PR comment / commit comment + video link
```

Stages communicate only through files in the run folder. Any stage can be re-run alone.

## 2. Stages

### 1. Ingest
- Sources: `--diff file`, `--git A..B` or `A...B` (local), `--pr N` (GitHub, Milestone 4),
  push event (`before..after`, uses the `--git` path).
- Outputs: `diff.raw.patch` (input as received), `diff.patch` (kept files only) and
  `ingest.json` (contract: `schemas/ingest.schema.json`). No timestamps, so the output is
  byte-identical for the same input and config.
- Parsing: an in-house parser for git-format unified diffs: added, modified, deleted,
  renamed and copied files, binary markers, mode-only changes, quoted paths, multiple hunks
  and "No newline at end of file".
- Filters (config `ingest.ignoreGlobs`, matched against the new path, or the old path for
  deletions). Skip reasons: `lockfile` (known lockfile names), `generated`, `vendored`,
  `binary`, `too_large` (single file over `maxFileBytes`, or dropped by the total budget),
  `ignored_by_config` (any other matching glob). Skipped files are listed in `ingest.json`
  and later copied to `review.json.stats`.
- Risk score per kept file (deterministic path heuristics): migrations, `domain/`,
  event consumers/producers/handlers/outbox/sagas, auth/guards and infrastructure config
  score higher; tests and docs score lower. Used to order files for the Reviewer and, when
  the kept diff exceeds `maxDiffBytes`, to keep the riskiest files (`truncated: true`).
- `HunkIndex` (read API over `ingest.json`): does a file exist, does a line range exist on a
  side, the text of a line, and whether a snippet appears in a file's diff lines. The
  Verifier, Director and Recorder use only this API.

### 2. Review (analyzers, then the Reviewer agent)
This stage has two halves and ADR-022 explains why. Deterministic rules go first; the model
handles only what needs judgement.

**Analyzers (`src/analyzers/`, no model).** Pure functions over `ingest.json`: six rules over
import statements and SQL strings, covering DDD layer boundaries and migration safety. They
need no dependency and no checkout, so they run for every source. Each rule quotes the line it
fired on, so its evidence is verbatim by construction. Findings carry `confidence: 0.95` and
are still checked by the Verifier.

**Reviewer agent.**
- Model: local Ollama by default and no API key (ADR-015, ADR-018); a hosted model is opt-in
  per run. Thinking on by default (ADR-021).
- Loop: the provider-neutral harness in `src/harness/` (`runAgent`), not a vendor SDK, because
  the default provider is local. Budgets, tracing and the response cache live there.
- Input: the diff rendered with explicit new-side line numbers (`src/agents/diff-view.ts`).
  This is required, not cosmetic: given a raw patch every model tested guessed line numbers
  badly (ADR-018).
- System prompt: built in code from `docs/REVIEW_RUBRIC.md` plus answer rules that each exist
  because a measured run got that thing wrong - how to read a numbered line, that evidence must
  be a line copied exactly (ADR-019), and an explicit severity anchor. The analyzer findings are
  listed as already reported so the model does not repeat them.
- Tools (read-only): `list_changed_files` and `get_diff_hunk(file)` always;
  `read_file(path, start, end)` and `grep_repo(pattern)` only when the run has a checkout,
  refusing paths that escape it.
- Output: `review.raw.json` (findings without `verification`), capped at
  `review.maxRawFindings`. A budget stop is not an error: the analyzer findings alone still
  make a valid review.

**Deferred to Milestone 4:** `tsc`, `eslint` with the reviewed repository's configuration, and
`dependency-cruiser`'s cross-file graph. Those need that repository's `node_modules`, its
`tsconfig` and its config, and a `--diff` run has no checkout at all.

### 3. Verifier
Two layers, and the first one is built (`src/verify/`, ADR-023).
1. Deterministic checks (no LLM, no network): the file is in the diff (`out_of_scope`), the
   line range exists on the given side (`lines_not_in_diff`), every `evidence` string appears
   in that file's diff lines (`claim_not_supported`), and no other survivor makes the same
   claim - same file, same category, overlapping range (`duplicate`). The checks run in that
   order, because each one needs the previous to hold. Failures become `dropped` with a reason
   and a note saying what failed. Then sort by severity, file and line, and cap at
   `review.maxFindings` (10), with `over_cap` for the rest. Ids are carried over from
   `review.raw.json` unchanged, so a finding can be followed from one file to the other.
   Survivors are marked `verification.status = "verified"`, unless they already carry a verdict.
2. Verifier agent (Milestone 3): for each surviving finding, sees only the relevant hunk(s) and
   the claim, and answers keep / downgrade / drop with a note. Default: a small model;
   optionally a larger one for high and critical findings only (cost flag). `style_only` is its
   reason to give, not the deterministic layer's.

### 4. Narrator agent
- Input: `review.json` only (never the raw diff, which keeps it grounded and cheap). Each
  finding is rendered as its summary, rationale, suggestion, file and evidence lines: enough
  to describe the code in plain words without reading it out.
- Rules: `docs/NARRATION_STYLE.md`, read fresh into the system prompt the way the rubric is.
- The model writes only the words (ADR-024). The code writes everything else: step ids,
  `kind`, `finding_id`, `focus` copied from the finding, `subtitle`, `estimated_seconds`, and
  the title (`Review: <source title>`). The script's shape is fixed by `checkScript`, so there
  is nothing there for a model to decide. `review.maxFindings` (10) plus an intro and a
  wrap-up is exactly the schema's 12-step ceiling, so no finding is ever left out for space.
- Deterministic post-checks, fed back to the model as repairs (max 2, then the stage fails):
  word count per step <= `narration.maxWordsPerStep`, an intro or wrap-up of 15 to 40 words,
  no markdown characters, no file names, paths or URLs, one step per kept finding in the
  review's order, and `focus` matching that finding.
- On failure the stage writes `script.rejected.json` and names both ways on: edit that draft
  into `script.json`, or change a budget, the style file or the model and re-run
  `spr stage narrate`. A stage boundary is a file, so a person can take over at that point.

### 5. TTS
- Provider interface: `synthesize(text, voice, speed) -> wav bytes`.
- Default provider: Kokoro-FastAPI container (OpenAI-compatible `/v1/audio/speech`).
- Text normalization before synthesis: pronunciation map (`NestJS -> Nest J S`,
  `PostgreSQL -> Postgres`, `DTO -> D T O`, `CQRS -> C Q R S`), strip backticks, expand `/`.
- Durations are measured with ffprobe and written to `audio/manifest.json`.

### 6. Director (pure)
- For each step: window = [start, start + duration]; next start = end + gap (default 400 ms).
- Intro: `show_title` at its window start, `hide_title` at end.
- Finding: `open_file` and `scroll_to` at `start - 300 ms` (clamped), `highlight` at start,
  `clear_highlight` at end.
- Wrap-up: `show_outro`.
- Consecutive steps in the same file skip `open_file`.

### 7. Recorder
- Playwright Chromium, viewport = video size, `record_video_dir` set on the context.
- Page: a local HTML file rendered with diff2html (side-by-side or line-by-line), plus a
  small injected script that tags rows with `data-file`, `data-side`, `data-line` and
  exposes `window.spr.{showTitle, openFile, scrollTo, highlight, clear, showOutro}`.
- Records `t0` (the time since context creation when the timeline starts) so the Composer
  can trim the loading frames.
- Executes actions by sleeping until `at_ms` relative to t0 (monotonic clock), then
  waits until `total_duration_ms` before closing the context.

### 8. Composer (ffmpeg)
- Builds one audio track: clips plus generated silence gaps, in timeline order.
- Trims `t0` from the video, merges audio, encodes H.264/AAC with `+faststart`.
- Generates SRT from `step_windows` (splitting long steps into two-line cues) and burns
  it in when `--subtitles burn`, or ships it as a sidecar file.
- Checks: `abs(video_duration - audio_duration) < 250 ms`, otherwise fail.

### 9. Publish
See `docs/cheatsheets/github-integration.md`. Summary:
- PR events: one sticky PR comment (updated on each push) with summary, findings table,
  and video link.
- Push events on branches without an open PR: commit comment (optional, off by default).
- Video storage: GitHub Actions artifact by default; object storage (S3-compatible) optional.

## 3. Trigger policy

| Event | Default behavior |
|---|---|
| `pull_request` opened / synchronize / reopened / ready_for_review | Review full PR diff (base...head). Skip drafts. |
| `push` to a branch that has an open PR | Skip (the PR run covers it). |
| `push` to a branch without a PR | Optional: review `before..after`, post commit comment. |
| `push` to the default branch | Skip by default. |
| Label `skip-video-review` or `[skip review]` in title | Skip. |
| Diff over size cap | Review top-risk files only, and say so in the intro. |

`concurrency` with `cancel-in-progress` ensures only the latest push on a PR is rendered.

## 4. Deployment

- Local: `docker/compose.yml` runs Kokoro-FastAPI (CPU). The tool runs with Node/pnpm on
  the host, or in its own container (official Playwright Node image + ffmpeg).
- Distribution: the tool is published as a Docker image (and optionally a composite
  GitHub Action), so service repos only add a workflow file.
- CI: GitHub Actions job with Kokoro as a service container. See the cheat sheet.
- Secrets: `ANTHROPIC_API_KEY` (or none when using Ollama), `GITHUB_TOKEN` (provided).

## 5. Cost model (estimate; verify current pricing)

- LLM: the only per-run paid cost when using a hosted model. Rough order: a few cents
  per PR with a small model, dominated by Reviewer input tokens. Cache hits cost nothing.
- TTS, rendering, encoding: free (local compute / CI minutes).
- CI minutes: a 3-minute video typically needs several minutes of runner time, mostly
  Playwright install, Kokoro startup and encoding. Cache the Playwright browsers and the
  Kokoro image.
- Storage: artifacts count against the repository's Actions storage quota.
