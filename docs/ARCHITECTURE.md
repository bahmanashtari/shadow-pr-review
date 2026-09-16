# Architecture

## 1. Overview

```
 GitHub event / local git
          |
     [1 Ingest] ------------------------------> diff.patch, hunk index
          |
     [2 Reviewer agent]  (read-only tools) ---> review.raw.json
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
- Sources: `--diff file`, `--git A..B` (local), `--pr N` (GitHub), push event (`before..after`).
- Filters (configurable globs): lockfiles (`package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`), `dist/`, `build/`, `coverage/`, generated clients, `*.snap`, binaries,
  files over a size cap. Skipped files are recorded in `review.json.stats`.
- Builds a hunk index: for every file, the set of valid new-side and old-side line numbers
  and their text. The Verifier and Director use this index.
- Context budget: if the diff is too large, prioritize by risk heuristics (migrations,
  `domain/`, event consumers/producers, auth, config) and note the truncation.

### 2. Reviewer agent
- Model: small hosted model by default (for example Claude Haiku), configurable.
- System prompt: built from `docs/REVIEW_RUBRIC.md` plus the output schema.
- Loop: a small custom tool-use loop on `@anthropic-ai/sdk` (tool schemas are plain JSON
  Schema). The Claude Agent SDK is an alternative if the loop grows.
- Tools (read-only): `list_changed_files`, `get_diff_hunk(file)`,
  `read_file(path, start, end)` at head revision, `grep_repo(pattern)` with result caps.
- Output: `review.raw.json` (findings without `verification`), max 15 raw findings.

### 3. Verifier
Two layers:
1. Deterministic checks (no LLM): file exists in diff, line range exists on the given side,
   every `evidence` string appears in the file's diff lines, no duplicates (same file and
   overlapping range and category). Failures become `dropped` with a reason.
2. Verifier agent: for each surviving finding, sees only the relevant hunk(s) and the
   claim, and answers keep / downgrade / drop with a note. Default: a small model; optionally
   a larger one for high and critical findings only (cost flag).
Then sort by severity and cap at 10 (`over_cap` for the rest).

### 4. Narrator agent
- Input: `review.json` only (never the raw diff, which keeps it grounded and cheap).
- Rules: `docs/NARRATION_STYLE.md`. One step per finding, plus intro and wrap-up.
- Deterministic post-checks: word count per step <= 60, no markdown characters, no file
  extensions, focus copied from the finding (the code sets focus; the model does not).

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
