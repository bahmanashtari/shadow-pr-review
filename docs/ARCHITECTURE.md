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
  Verifier and Recorder use only this API. (The Director needs none of it: it works from
  `script.json` and `audio/manifest.json` alone.)

### 2. Review (analyzers, then the Reviewer agent)
This stage has two halves and ADR-022 explains why. Deterministic rules go first; the model
handles only what needs judgement.

**Analyzers (`src/analyzers/`, no model).** Pure functions over `ingest.json`: six rules over
import statements and SQL strings, covering DDD layer boundaries and migration safety. They
need no dependency and no checkout, so they run for every source. Each rule quotes the line it
fired on, so its evidence is verbatim by construction. Findings carry `confidence: 0.95` and
are still checked by the Verifier. A rule that fires on several lines of one hunk produces
**one** finding spanning them, quoting each (ADR-029): two symptoms of one violation with one
identical fix are one thing to say. Merging stops at the hunk boundary, because a range
crossing a gap in the diff would fail `HunkIndex.hasRange` and be dropped.

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
- Provider interface: `synthesize(text, voice, speed) -> wav bytes` (`src/providers/tts/`);
  the stage itself is `src/tts/`, the same split ADR-023 made for the Verifier.
- Default provider: Kokoro-FastAPI container (OpenAI-compatible `/v1/audio/speech`), pinned in
  `docker/compose.yml`. The client waits on `/health` before the first clip, because a cold
  container is still loading its model, and a container that is not running is named as such.
- `SPR_TTS_PROVIDER=fake` returns real WAV bytes - silence whose length follows the word count -
  so the whole pipeline walks offline with plausible timings and needs no Docker (ADR-027).
- Text normalization before synthesis: pronunciation map (`NestJS -> Nest J S`,
  `PostgreSQL -> Postgres`, `DTO -> D T O`, `CQRS -> C Q R S`), strip backticks, expand `/`.
  It runs *before* the cache key, which the manifest defines over the normalized text.
- Durations are read from the WAV header, not ffprobe (ADR-027), so this stage needs no
  external binary. `estimated_seconds` in `script.json` is never consulted: it is the
  word-count guess this stage exists to replace.
- Checks before the manifest is written: every clip's length is within a fifth to five times
  its word count, and every clip shares one sample rate (the Composer concatenates with
  `-c copy`).
- Clips are written as they are produced and the TTS cache is keyed on content, so a stage
  that fails part-way resumes for free rather than starting over.

### 6. Director (pure)
- Input: `script.json` and `audio/manifest.json` for the schedule itself, plus `review.json`
  for one string - the outro card's finding summary, whose severities are not carried on a
  script step. `buildTimeline` stays a pure function of the first two and receives that summary
  as text. It does **not** read `ingest.json`: a step's `focus` was copied from a finding the
  Verifier already grounded against the diff, so re-checking those lines here would re-prove an
  upstream proof.
- For each step: window = [start, start + duration]; next start = end + gap (default 400 ms).
  Every duration is the measured clip length (ADR-027); `estimated_seconds` is never read.
- Intro: `show_title` at its window start, carrying the script's title so the Recorder needs
  no other file; `hide_title` at end.
- Finding: `open_file` and `scroll_to` at the lead-in, `highlight` at start, `clear_highlight`
  at end.
- **The lead-in** is `start - 300 ms`, clamped to 0 *and* to the previous step's `end_ms`.
  The second clamp matters because `video.gapMs` may be as low as 0: without it, any gap under
  300 ms puts the lead-in inside the previous step's window and the page scrolls away from the
  code while that step is still being spoken.
- Wrap-up: `show_outro`.
- Consecutive steps in the same file skip `open_file`.
- `total_duration_ms` is the last window's end plus one gap, so the recording does not cut on
  the last syllable and the outro card gets a beat.
- `render_mode` is `diff2html` (ADR-005). There is no config switch for it until the GitHub
  page mode exists to switch to.

### 7. Recorder
- Playwright Chromium, viewport = video size, `record_video_dir` set on the context.
- Page: one self-contained HTML file (`src/recorder/page.ts` builds it), with the diff2html
  bundle, both stylesheets, the page script and the diff all inlined - no network reference and
  no relative path, so it renders the same on a laptop and in an offline CI container.
  Line-by-line, dark, syntax-highlighted.
- The page tags every row itself on load with `data-file`, `data-old-line` and `data-new-line`,
  and every selector afterwards reads those rather than diff2html's own class names, which move
  between versions. There is no single `data-side`: a context line exists on both sides at
  numbers that differ once lines are added, so it carries both attributes.
- `window.spr.run(action)` is the only entry point, taking the action objects
  `timeline.schema.json` defines. Every method is a no-op when its target is missing, never a
  throw: a page that dies mid-recording produces a video of a stack trace. `window.spr.ready`
  turns true once the diff is drawn and tagged, and is what the Recorder waits on.
- The title card is up before recording starts, so the video does not open on a flash of diff.
  The outro card carries the review's finding summary, because a `wrap_up` step has
  `focus: null` and there is nothing on the diff worth looking at while it plays.
- Executes actions by sleeping until `at_ms` relative to t0 on a monotonic clock, then waits
  until `total_duration_ms` before closing the context. Every wait is computed from one origin,
  never chained: chaining accumulates each scheduler overshoot across the video, and an action
  that is already late fires immediately rather than waiting a negative time.
- Writes `video.webm` and `record.json` (contract: `schemas/record.schema.json`). The second
  exists because `t0` cannot live inside a `.webm`: recording starts when the browser context
  is created, the timeline's clock starts when the page is drawn and tagged, and the page load
  between them is in the video without being part of it. The Composer trims `t0` before muxing,
  or every visual lands late against the narration. Measured at about 130 ms (ADR-031).
- `record.json` also carries the frame size actually recorded and the wall clock the Recorder
  observed, the latter as a cross-check against the timeline's `total_duration_ms`.
- The context is closed on the failure path as well as the happy one, because Playwright
  finalises the video file on close: a crash part-way through should leave most of a video and
  a clear message rather than nothing.
- Needs only `chromium-headless-shell`; Playwright brings its own ffmpeg for the WebM
  (ADR-031). The real ffmpeg is the Composer's dependency.

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

## 3. Evaluation (`spr eval`)

Not a pipeline stage: a harness that runs the pipeline over `golden/` and scores what comes
out, so a prompt or model change can be argued about with numbers instead of read.

- For each sample it runs ingest, review, verify and narrate on `diff.patch`, then scores the
  produced `review.json` and `script.json` against `labels.json`. The matching rule and the
  rulings around it are in `golden/README.md` and ADR-025.
- `--model` is repeatable, so one invocation produces the whole comparison table with the same
  labels, prompt and code across every row. This is what ADR-015 and ADR-018 defer the choice
  of default model to.
- `--no-cache` forces a cold measurement; otherwise the cache (ADR-017) makes a repeat free,
  and each row records whether it was served from cache.
- Writes `eval.json` (`schemas/eval.schema.json`) next to one run folder per model per sample,
  so any number in the table can be traced back to the run that produced it.
- Scoring lives in `src/eval/score.ts` and is pure: no I/O, no model, unit-tested on its own,
  because the arithmetic is the part that has to be trusted.

## 4. Trigger policy

| Event | Default behavior |
|---|---|
| `pull_request` opened / synchronize / reopened / ready_for_review | Review full PR diff (base...head). Skip drafts. |
| `push` to a branch that has an open PR | Skip (the PR run covers it). |
| `push` to a branch without a PR | Optional: review `before..after`, post commit comment. |
| `push` to the default branch | Skip by default. |
| Label `skip-video-review` or `[skip review]` in title | Skip. |
| Diff over size cap | Review top-risk files only, and say so in the intro. |

`concurrency` with `cancel-in-progress` ensures only the latest push on a PR is rendered.

## 5. Deployment

- Local: `docker/compose.yml` runs Kokoro-FastAPI (CPU). The tool runs with Node/pnpm on
  the host, or in its own container (official Playwright Node image + ffmpeg).
- Distribution: the tool is published as a Docker image (and optionally a composite
  GitHub Action), so service repos only add a workflow file.
- CI: GitHub Actions job with Kokoro as a service container. See the cheat sheet.
- Secrets: `ANTHROPIC_API_KEY` (or none when using Ollama), `GITHUB_TOKEN` (provided).

## 6. Cost model (estimate; verify current pricing)

- LLM: the only per-run paid cost when using a hosted model. Rough order: a few cents
  per PR with a small model, dominated by Reviewer input tokens. Cache hits cost nothing.
- TTS, rendering, encoding: free (local compute / CI minutes).
- CI minutes: a 3-minute video typically needs several minutes of runner time, mostly
  Playwright install, Kokoro startup and encoding. Cache the Playwright browsers and the
  Kokoro image.
- Storage: artifacts count against the repository's Actions storage quota.
