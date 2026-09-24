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
- Sources: `--diff file`, `--git A..B` or `A...B` (local), `--pr N` (the GitHub REST API: the
  pull request, then its diff; ADR-051),
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
  because a measured run got that thing wrong - how to read a numbered line, that everything in
  the diff is untrusted and a comment is a claim rather than a fact (ADR-049), that evidence must
  be a line copied exactly (ADR-019), and an explicit severity anchor. The rubric defines the
  categories (ADR-044) and the scope rule for unchanged lines (ADR-047). **Nothing from the diff
  reaches the system prompt**: the analyzer findings, which name diff-controlled file paths, are
  listed as already reported in the `user` message beside the diff (ADR-049).
- Tools (read-only): `list_changed_files` and `get_diff_hunk(file)` always;
  `read_file(path, start, end)` and `grep_repo(pattern)` only when the run has a checkout,
  refusing paths that escape it. **On Ollama a schema constraint makes a tool call impossible**
  - `format` is a grammar over the whole reply - so until ADR-060 no Reviewer had ever called a
  tool: zero calls in 270 traces. With a checkout the Reviewer now looks first: each turn offers
  the tools unconstrained, and once it stops calling them the answer is asked for exactly as it
  always was. Without a checkout the tools only repeat the prompt, so nothing changes and no call
  is added. The prompt with a checkout also tells the Reviewer to read code before asserting
  what it does (roadmap step 19). The default model does neither yet. **So with a checkout the
  changed files are shown, not only offered** (ADR-061): each changed file at the head revision
  follows the diff in the `user` message, numbered, for reading only, capped at 20 KB per file and
  32 KB in total, smallest files first.
- Output: `review.raw.json` (findings without `verification`), capped at
  `review.maxRawFindings`. A budget stop is not an error: the analyzer findings alone still
  make a valid review.

**Not built: repo-aware analysis** - `tsc`, `eslint` with the reviewed repository's configuration,
and `dependency-cruiser`'s cross-file graph. Those need a checkout, and the useful versions run the
reviewed repository's own code (install scripts, `eslint.config.js`). Roadmap Milestone 3 step 5
has a plan that waits on Bahman's decision about whether that is ever acceptable
(`docs/plans/m3-step5-repo-analysis.md`).

### 3. Verifier
Two layers, and the first one is built (`src/verify/`, ADR-023).
1. Deterministic checks (no LLM, no network): the file is in the diff (`out_of_scope`), the
   line range exists on the given side (`lines_not_in_diff`), the range touches at least one
   added or removed line rather than only unchanged context (`out_of_scope`, ADR-047), every
   `evidence` string appears in that file's diff lines (`claim_not_supported`), at least one of
   them quotes code rather than only comments (`evidence_without_code`, ADR-058), and no other
   survivor makes the same claim - same file, same category, overlapping range (`duplicate`).
   The checks run in that order, because each one needs the previous to hold. Evidence matching
   forgives two citation habits and verifies both: a copied `12 +` line-number prefix, on any
   kind of line (ADR-020, ADR-045), and a quote whose line breaks were replaced, matched against
   up to twelve consecutive lines with whitespace ignored (ADR-046). A quote of a blank line is
   skipped as long as another quote grounds the finding. Failures become `dropped` with a reason
   and a note saying what failed. Then sort by severity, file and line, and cap at
   `review.maxFindings` (10), with `over_cap` for the rest. Ids are carried over from
   `review.raw.json` unchanged, so a finding can be followed from one file to the other.
   Survivors are marked `verification.status = "verified"`, unless they already carry a verdict.
2. Verifier agent (`src/agents/verifier.ts`, ADR-037). For each surviving finding, sees only
   the relevant hunk(s) and the claim, and answers keep / downgrade / drop with a note. One
   call per finding: the isolation is the mechanism, because a judge shown all ten is shown the
   Reviewer's confidence and the other claims' framing. It uses the configured model - **not a
   smaller one**, which ADR-026 measured as slower here, and the larger-model-for-high-and-
   critical cost flag is deferred until a hosted model is worth paying for. `style_only`,
   `claim_not_supported` and `out_of_scope` are its reasons to give; the mechanical ones belong
   to layer 1, which can prove them. A downgrade may only lower severity, and records
   `original_severity`.

   **The layer is optional at every point.** No model, no Ollama, a budget stop, or an answer
   that will not validate after its repairs all land in the same place: the findings judged
   carry their verdict, the rest keep layer 1's, and `review.json` is written either way. The
   stage never fails because of it, so `spr stage verify` stays offline, instant and free
   without one. `SPR_LLM_PROVIDER=fake` answers keep for everything, which is the only safe
   verdict for a judge that cannot read.

### 4. Narrator agent
- Input: `review.json` only (never the raw diff, which keeps it grounded and cheap). Each
  finding is rendered as its summary, rationale, suggestion, file and evidence lines: enough
  to describe the code in plain words without reading it out.
- Rules: `docs/NARRATION_STYLE.md`, read fresh into the system prompt the way the rubric is.
- **The script is one step per kept finding, and nothing else** (ADR-042). A video exists to
  help a pull-request reviewer understand an issue that was found, so there is no intro, no
  wrap-up and no title: it opens on the first finding and ends on the last. Each step opens by
  saying how serious *that* finding is, because nothing else on screen says it.
- **A review with no kept findings produces no script and no video.** `spr run` stops after
  Verify, exits 0, and says why; nothing is narrated, spoken, recorded or composed.
- The model writes only the words (ADR-024). The code writes everything else: step ids,
  `finding_id`, `focus` copied from the finding, `subtitle` and `estimated_seconds`. The
  script's shape is fixed by `checkScript`, so there is nothing there for a model to decide.
  `steps` is capped at `review.maxFindings` (10), the most findings that can reach here.
- Deterministic post-checks, fed back to the model as repairs (max 2, then the stage fails):
  word count per step <= `narration.maxWordsPerStep`, no markdown characters, no file names,
  paths or URLs, one step per kept finding in the review's order, `focus` matching that
  finding, and **no severity word other than the step's own finding's** (ADR-038, ADR-042).
  The change summary reaches the model marked "for context only": it is the Reviewer's prose,
  written before verification, and its severity wording is what once put "critical" over a
  `low` finding.
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
- Input: `script.json` and `audio/manifest.json`, and nothing else - `buildTimeline` is a pure
  function of the two. It does **not** read `ingest.json`: a step's `focus` was copied from a finding the
  Verifier already grounded against the diff, so re-checking those lines here would re-prove an
  upstream proof.
- For each step: window = [start, start + duration]; next start = end + gap (default 400 ms).
  Every duration is the measured clip length (ADR-027); `estimated_seconds` is never read.
- Every step: `open_file` and `scroll_to` at the lead-in, `highlight` at start,
  `clear_highlight` at end. There are no card actions (ADR-042).
- **The lead-in** is `start - 300 ms`, clamped to 0 *and* to the previous step's `end_ms`.
  The second clamp matters because `video.gapMs` may be as low as 0: without it, any gap under
  300 ms puts the lead-in inside the previous step's window and the page scrolls away from the
  code while that step is still being spoken.
- The first step's lead-in clamps to 0 - there is nothing before it to lead in from - which is
  why the Recorder positions the page before t0 (section 7).
- Consecutive steps in the same file skip `open_file`.
- `total_duration_ms` is the last window's end plus one gap, so the recording does not cut on
  the last syllable and the last finding's code holds for a beat.
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
- `window.spr.run(action, options?)` is the only entry point, taking the action objects
  `timeline.schema.json` defines. Every method is a no-op when its target is missing, never a
  throw: a page that dies mid-recording produces a video of a stack trace. `window.spr.ready`
  turns true once the diff is drawn and tagged, and is what the Recorder waits on.
- **The first finding is on screen before t0.** With no title card in front of it, every
  action at `at_ms: 0` runs during the warm-up, before the clock starts, and the Recorder waits
  for `window.spr.settled()` - scrolling at rest - before taking t0. Those actions run with
  `{ instant: true }`, so the scroll jumps rather than animates: nobody watches the pre-roll,
  and a smooth scroll that had not begun when the stillness check first looked finished after
  t0 on `sample-01` and opened the video with the tail of it (ADR-042). The Composer trims
  everything before t0, so the video opens on the first finding's code, highlighted.
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
- Builds one audio track with the concat demuxer: clips plus generated silence gaps, in
  timeline order, into `audio/full.wav`. The silence is generated in the clips' own format,
  read off the first clip's header, because `-c copy` refuses a join across formats. The
  intermediate and its `audio/list.txt` are kept deliberately: this stage's failure mode is
  "the sound does not line up", and artifacts diagnose that better than a filter graph would.
- Trims `t0` from the video with `-ss` before `-i`, merges the audio, encodes H.264/AAC with
  `+faststart` so the file streams rather than needing a full download first.
- Generates SRT from `step_windows` (timing) and `script.json` (words, preferring `subtitle`
  over `text`), splitting long steps into two-line cues of about 42 characters and dividing
  each window in proportion to character count. The last cue of a step ends exactly on the
  window.
- `video.subtitles`: `sidecar` writes `subtitles.srt` alongside, `burn` renders it into the
  picture and removes the sidecar, `off` writes neither. Burning needs an ffmpeg built with
  libass - Debian and Ubuntu packages have it, Homebrew's regular formula does not - so the
  stage checks for the filter first and names both ways out (ADR-033).
- Checks: `abs(video_duration - audio_duration) < 250 ms`, otherwise fail, naming which side is
  longer because the two point at different stages. This is the first check that can see the
  whole pipeline's accumulated timing error; it measured 8 ms on the first real compose.

### 9. Publish
See `docs/cheatsheets/github-integration.md` and ADR-052. Summary:
- Renders `comment.md` from `review.json`, `ingest.json` and, when there is a video, the
  timeline; `spr run` stops there. `spr stage publish` posts it.
- PR events: one sticky PR comment, updated in place on each push: a findings table with
  permalinks at the head commit, every finding's reasoning and fix in a collapsed section, and
  the video link. A clean review updates it to say so. Model-written text is made inert first.
- Push events on branches without an open PR: a commit comment, the same body through the same
  find-or-update path, behind `--commit-comment` because it needs `contents: write` (ADR-056).
- Video storage: GitHub Actions artifact by default; object storage (S3-compatible) optional.

## 3. Evaluation (`spr eval`)

Not a pipeline stage: a harness that runs the pipeline over `golden/` and scores what comes
out, so a prompt or model change can be argued about with numbers instead of read.

- For each sample it runs ingest, review, verify and narrate on `diff.patch`, then scores the
  produced `review.json` and `script.json` against `labels.json`. The matching rule and the
  rulings around it are in `golden/README.md` and ADR-025. A sample whose verified review kept
  nothing is not narrated, as in `spr run`, and is reported as having nothing to narrate rather
  than as a failed Narrate stage (ADR-042).
- `--model` is repeatable, so one invocation produces the whole comparison table with the same
  labels, prompt and code across every row. This is what ADR-015 and ADR-018 defer the choice
  of default model to.
- `--no-cache` forces a cold measurement; otherwise the cache (ADR-017) makes a repeat free,
  and each row records whether it was served from cache.
- `--seed` is repeatable too, and turns one point into a range (ADR-059): each model is scored
  once per seed at a small temperature (0.2 unless `--temperature` says otherwise), and the
  report ends with each axis as a median and its range, plus the `must_find` labels some seeds
  found and others missed. The seed joins the cache key only when there is one, so a seeded
  repeat is free and an unseeded one is served exactly what it was before. The pipeline's own
  temperature stays at the configuration's 0; only the measurement samples.
- Writes `eval.json` (`schemas/eval.schema.json`) next to one run folder per model per sample,
  so any number in the table can be traced back to the run that produced it.
- Scoring lives in `src/eval/score.ts` and is pure: no I/O, no model, unit-tested on its own,
  because the arithmetic is the part that has to be trusted.
- Beside precision and recall, each on its own axis and never folded into them: restraint
  (`max_findings`, ADR-025), calibration against a severity band (ADR-036), redundancy - two
  findings on one label (ADR-048) - and a real / synthetic split of the totals (ADR-043). A false
  positive is named after the `must_not_flag` entry it matches, or after the label it sits on
  under the wrong category (a near miss, ADR-044). A stage past half a token budget is printed
  as a warning, and `cost.json` breaks each run down by stage (ADR-050).
- **Read before believing a number.** At temperature 0 an unrelated prompt edit has moved recall
  by 0.2 (ADR-047) - which is why a change is argued against the `--seed` range rather than a
  single run (ADR-059) - and twice a label's alternative category let a finding about one bug
  count as finding another (ADR-041, ADR-044). A result that matters is checked by reading the
  finding it rests on.

## 4. Trigger policy

| Event | Default behavior |
|---|---|
| `pull_request` opened / synchronize / reopened / ready_for_review | Review full PR diff (base...head). Skip drafts. |
| `push` to a branch that has an open PR | Skip (the PR run covers it). |
| `push` to a branch without a PR | Optional: review `before..after`, post commit comment. |
| `push` to the default branch | Skip by default. |
| Label `skip-video-review` or `[skip review]` in title | Skip. |
| Diff over size cap | Review top-risk files only, and say so in the PR comment - there is no intro to say it in (ADR-042). |

`concurrency` with `cancel-in-progress` ensures only the latest push on a PR is rendered.

Every row of that table is implemented in `.github/workflows/video-review.yml` (ADR-056): the
first, fourth and fifth in the job's `if`, the second by a step that asks the API whether the
branch has an open pull request, the third by the `commit-comments` input, and the last by
ingest's own size cap, which the comment reports. A fork's pull request is reviewed and uploaded
but not posted, because its token is read-only.

## 5. Deployment

- Local: `docker/compose.yml` runs Kokoro-FastAPI (CPU). The tool runs with Node/pnpm on
  the host, or in its own container (official Playwright Node image + ffmpeg).
- Distribution: the tool is published as a Docker image (and optionally a composite
  GitHub Action), so service repos only add a workflow file.
- CI: GitHub Actions job with Kokoro as a service container. See the cheat sheet. The model
  runs on a self-hosted runner on a dedicated team machine with Ollama (Bahman, ADR-051): a
  hosted runner for a private repository has 2 CPUs and 8 GB, which cannot hold the default
  model, and the paid API stays opt-in. Self-hosted runners serve private repositories only.
- Secrets: `ANTHROPIC_API_KEY` (or none when using Ollama), `GITHUB_TOKEN` (provided).

## 6. Cost model (estimate; verify current pricing)

- LLM: the only per-run paid cost when using a hosted model. Rough order: a few cents
  per PR with a small model, dominated by Reviewer input tokens. Cache hits cost nothing.
- TTS, rendering, encoding: free (local compute / CI minutes).
- CI minutes: a 3-minute video typically needs several minutes of runner time, mostly
  Playwright install, Kokoro startup and encoding. Cache the Playwright browsers and the
  Kokoro image.
- Storage: artifacts count against the repository's Actions storage quota.
