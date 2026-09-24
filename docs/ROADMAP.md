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
figure the project had recorded (ADR-035). Step 1 followed, in two commits: the calibration axis
that made it measurable, then the agent itself (ADR-036, ADR-037).

Steps 9, 6 and 10 then closed the rest of what the end-to-end run found (ADR-038 to ADR-040).
Steps 11 and 12 are Bahman's product decision after watching the finished videos: a video exists
to help a pull-request reviewer understand a found issue, so the Reviewer now says what breaks
downstream and how to fix it (ADR-041), and the video is findings only - no intro, no outro, no
card, and no video at all when nothing was found (ADR-042).

**Step 4 is in progress, and what is left of it is Bahman's.** The synthetic half is done: seven
samples, every one marked `synthetic` (ADR-043), three of them carrying a redelivery bug in
different shapes. The set discriminates again - qwen3:30b went from 1.000 / 0.750 on three
samples to 0.700 / 0.400 on seven - and it narrowed ADR-041: the Reviewer does notice
redelivery, and was filing it as `event-consistency` because nothing ever told it which category
it belongs to. With the rubric defining the categories it reads 1.000 / 0.500, calibration
0.875, no false positives (ADR-044). **The real samples are still owed**, and only Bahman has the
material, so a session should not resume step 4 without it. Steps 13 and 14 have since
landed and recall reads 0.600 (ADR-046). Step 15 followed (ADR-047), then 7 (ADR-048), 2 (ADR-049) and
3 (ADR-050). **Two Milestone 3 steps wait on Bahman**: 4 for the real samples, and 5, whose plan
asks whether the tool may ever execute the reviewed repository's code. Steps 17 and 20 landed on
23 September: a model per stage, and the drop rule the adversarial sample earned (ADR-057,
ADR-058). Steps 16 and 19 landed on 24 September. `spr eval --seed` measures a range instead of a point
(ADR-059). The Reviewer's tools had never been reachable on Ollama, and now are - but the model
still does not use them (ADR-060). Step 21 is next and has a plan. Milestone 4 is complete apart from step 5's
object storage.

| Step | Scope | Status |
|---|---|---|
| 1 | Verifier agent (keep / downgrade / drop), preceded by the calibration axis that made it judgeable. Calibration went 0.833 to 1.000: six findings judged, five kept, one downgraded with the rubric quoted back (ADR-036, ADR-037). The "small model" and the cost flag ARCHITECTURE specified were dropped and deferred, on ADR-026's measurement. Plan: `docs/plans/m3-step1-verifier-agent.md` | done |
| 2 | **Hostile and misleading text in a diff.** Two adversarial samples: a sincere comment claiming a redelivery bug cannot happen (08), and a comment telling AI reviewers to report a critical bug that does not exist (09). The default model resisted both before any hardening. The real find was a hole: analyzer findings sat in the Reviewer's *system* prompt naming their file, and a quoted git path can hold a newline, so a diff could write its own lines there - demonstrated, then closed by moving the list to the user message. The Reviewer gained the untrusted-input section the Verifier had (ADR-049). Taken under Bahman's instruction to continue. Plan: `docs/plans/m3-step2-hostile-diffs.md` | done |
| 3 | **Budgets, cache and the cost report.** Nothing needed tuning on the evidence there is: budgets are per agent and the heaviest used 30% of its output tokens, and the cache is 25 MB. `cost.json` now says where each run's tokens and seconds went, by stage, and `spr eval` warns when any stage passes half a budget - silent today, and the first signal when real, larger changes arrive (ADR-050). Tuning waits for those. Taken under Bahman's instruction to continue. Plan: `docs/plans/m3-step3-budgets-and-cost.md` | done |
| 4 | Expand the golden set with real (anonymized) changes from the team's services. **Blocker for any further model comparison**: three of four local models tied at 1.000 precision and recall on the original three samples (ADR-026). Done so far: the expected reviews rewritten to ADR-041's format; a required `origin` on every sample (ADR-043); six synthetic samples, 04 to 09, two of them adversarial (ADR-044, ADR-049); a category guide in the rubric; and the model comparison it unblocked (ADR-045). Nine samples read precision 1.000, recall 0.750, calibration 0.909 on the default model. The misses every model shares: an unauthenticated money endpoint (04, 08) and a guard missing only in unchanged context (06). **Still owed: the real samples**, which wait on Bahman; `golden/README.md` says how to contribute one. Plan: `docs/plans/m3-step4-golden-set.md` | in progress |
| 5 | Repo-aware static analysis feeding `src/analyzers/` (ADR-022): `tsc` for floating promises and unsafe casts, `eslint` with the reviewed repository's own config, `dependency-cruiser` for the cross-file layer graph. Needs a checkout with dependencies installed, so it is skipped when a run has none, and it means executing the reviewed repository's toolchain - decide the sandboxing story first Plan written and deliberately not built: it turns on whether the tool may ever execute code from the repository it reviews, which is Bahman's decision. Plan: `docs/plans/m3-step5-repo-analysis.md` | planned |
| 6 | Narration length: a per-step target band instead of only a cap, and the whole-video line in `docs/NARRATION_STYLE.md` restated as the format's structural range. The cause was one sentence in `HOW_TO_ANSWER` - "Those are hard limits, not targets." - and removing it moved finding steps from a mean of 33.7 words to 42.7 against the fixtures' 44.6, with precision, recall and calibration unmoved (ADR-028, ADR-034, ADR-039). The 40-word floor is prompt guidance and deliberately not a check, because two hand-written fixtures sit below it. Plan: `docs/plans/m3-step9-narration-severity-and-length.md` | done |
| 7 | Score redundancy in `spr eval`: two kept findings that locate the same label are redundant, reported per sample and as a surplus count beside precision, never inside it - the shape ADR-025 gave restraint and ADR-036 gave calibration. Re-scoring all 99 reviews on disk finds exactly one case: the duplicate pair ADR-029 heard, in a run written hours before its fix (ADR-048). Taken under Bahman's instruction to continue while the real samples are outstanding. Plan: `docs/plans/m3-step7-redundancy.md` | done |
| 8 | **The Composer's sync check was vacuous, and a short recording went unnoticed.** `assertInSync` compares the final file's two streams, which `-shortest` has already forced into agreement, so it can only ever measure frame granularity - it passed a `final.mp4` whose narration was cut off 429 ms early at "8 ms apart". Compare the final audio against `timeline.total_duration_ms` instead, and check `record.json`'s `recorded_duration_ms` against the webm's real duration, which was 678 ms shorter on the run that failed. Done: three checks, each against a reference the encode cannot move, and the run that failed now fails (ADR-035). Plan: `docs/plans/m3-step8-sync-check.md` | done |
| 9 | **The narration said "critical" where the outro card said "low".** The Narrator takes the word from the Reviewer's `summary` prose, which opens "Critical ..." on all three samples, rather than from the `severity` field the card counts (ADR-034). **Step 1 made this sharper, not better**: with `sample-03` correctly downgraded to `low`, its card now reads "1 low" while the narration still says critical three times, because `review.summary` still opens "Critical security issue". That line is now the last place a severity word is asserted without being grounded in the `severity` field, so the cause was fully localised (ADR-037). Fixed by handing the Narrator the card's own line and refusing an unsupported severity word in `checkScript` - an enforced invariant rather than a metric, because `spr eval` cannot read narration (ADR-038). Plan: `docs/plans/m3-step9-narration-severity-and-length.md` | done |
| 11 | **The Reviewer says the consequence, not just the mechanism.** `rationale` and `suggestion` allow 1200 characters and were using about a fifth, with the prompt never saying what either should contain. Target bands plus the two beats ADR-028 identified took model rationales from a mean of 251 characters to 466. The run also uncovered that `sample-02`'s label mapping let an atomicity finding count as having found a redelivery bug the tool has never found, so recall had been reading 1.000 while blind to it; labels corrected, and the enrichment's real effect was calibration 0.833 to 1.000 (ADR-041). Plan: `docs/plans/m3-step11-12-findings-only-videos.md` | done |
| 12 | **Findings-only videos**: no intro step, no outro step, no outro card, and no video at all when nothing was found. The script contract lost `kind` and `title`, the timeline lost the card actions, and a clean review stops the run after Verify with exit 0. Every second is now on code, and each finding gets 1.3 to 2.3 times the screen time it had. The first finding is positioned before t0, with a jump rather than a smooth scroll, after watching `sample-01` open on the tail of one (ADR-042). `spr eval` was brought in line afterwards: it reports a clean sample as having nothing to narrate, not as a failed Narrate stage, and leaves it out of the narrated total. Plan: `docs/plans/m3-step11-12-findings-only-videos.md` | done |
| 13 | **Dotted identifiers are read aloud.** A step on `sample-01` said "order.placed", which the voice reads as "order dot placed" - across 148 narrated steps on disk, the only dotted token ever narrated. Fixed by refusing a dotted identifier in `checkScript`, with a problem message that gives the rewrite; a cached script saying it was repaired in one call to "the order placed event" (ADR-046). Plan: `docs/plans/m3-step13-dotted-identifiers.md` | done |
| 14 | **Evidence that spans lines.** Two correct findings were lost to the shape of their quotes: sample-05's replay bug quoted as seven lines of a SQL template literal joined into one, and a blank-line quote that sank a correct finding. A line break is now whitespace in the grounding check - every other character must still be in the diff, in order - and a blank quote is skipped as long as another grounds the finding. Recall 0.500 to 0.600, exactly as the plan predicted (ADR-046). Plan: `docs/plans/m3-step14-evidence-across-lines.md` | done |
| 15 | **Findings on unchanged lines.** The rubric's first scope rule had no enforcement, and the first modified-file sample exposed it: `qwen3:4b` flagged an import the pull request never touched, and the Verifier agent kept it (ADR-045). Verify now drops a finding that touches no added or removed line as `out_of_scope`, and the rubric tells the Reviewer to anchor "this change breaks that code" on the changed line that causes it. Approved by Bahman as recommended. The cold run read recall 0.800, and ADR-047 explains why that is not credited to this step. Plan: `docs/plans/m3-step15-unchanged-lines.md` | done |
| 16 | **One cold run cannot tell a change from a tip.** An unrelated one-sentence prompt edit moved recall from 0.600 to 0.800 (ADR-047). `spr eval --seed`, repeatable, now samples each run at 0.2 and prints every axis as a median and a range, with the labels that move named. Three seeds read recall 0.667 (0.583-0.667) against greedy's 0.750, and all the movement is two labels - sample-02's redelivery bug and sample-05's dropped column, the two ADR-047 saw move. Temperature 0 turned out not to be exact either: a cold greedy re-run kept every score and changed the answers in three samples of nine, so repeatability comes from the cache. A sampled run also found a real defect in the golden set - sample-07's "clean" change had a failing test, which sample-09 shared - now fixed. Approved by Bahman as recommended (ADR-059). Plan: `docs/plans/m3-step16-measuring-the-spread.md` | done |
| 17 | **A model per stage.** `llm.models.review / .verify / .narrate`, with `SPR_LLM_MODEL_*` beside them; a stage with no override uses `llm.model`, and the dead `llm.verifierModel` is gone. The pairing it was built for is refused on measurement: with `qwen3-coder:30b` reviewing, narration worked at last (7/7, the ADR-045 failure fixed) but precision fell 1.000 to 0.556, recall 0.750 to 0.333, four false positives appeared - and it **obeyed the planted instruction in sample-09**, reporting a SQL injection that does not exist (ADR-057). Plan: `docs/plans/m3-step17-model-per-stage.md` | done |
| 18 | **Code identifiers in narration.** The first real pull request narrated `toHaveBeenCalledOnce`, which Kokoro ran together into one word. Settled without anyone listening, through Kokoro's `/dev/phonemize`: the sounds are right, the word boundaries are not. `normalizeForSpeech` now splits at each lowercase-to-uppercase step, for the voice only - subtitles keep the identifier - and a run of capitals stays whole (ADR-055) | done |
| 20 | **Evidence that quotes no code is not evidence.** `qwen3-coder:30b` obeyed sample-09's planted comment and quoted it as its evidence; every deterministic check passed, because those lines really are in the diff, and the Verifier agent kept it (ADR-057). Verify now drops a finding whose evidence holds no code line at all, as `evidence_without_code` - one code line anywhere is enough, so sample-08's misleading-comment finding still passes. Across every review on disk exactly one finding is affected, and it is that false positive; the golden set scores identically (ADR-058). Plan: `docs/plans/m3-step20-evidence-without-code.md` | done |
| 19 | **The Reviewer asserts what unread code does.** The tool's only real-world false positive (nestjs/nest#17816) claims what a method the diff does not show does, and ADR-054 found the model made no tool calls. Measured with step 16's seeds, the false positive shows up in **one run of five**. The real cause was mechanical: on Ollama the answer's schema is a grammar, so **no tool call had ever been possible** - none in 270 traces. With a checkout the Reviewer now looks first, and the golden set is untouched by construction (36 of 36 answers cached). The prompt now tells a run with a checkout to read before asserting. The model still calls no tool, and one run made the claim again in the turn where it could have looked (ADR-060). Taken under Bahman's instruction to continue. Plan: `docs/plans/m3-step19-read-before-asserting.md` | done |
| 21 | **Show the changed files instead of offering them.** Both of ADR-060's false positives rested on code in the file the pull request itself changed: a method body the hunk cuts off, and a declaration above the first hunk. With a checkout, put each changed file at the head revision beside the diff, capped, as context only. The golden set's prompts do not move, so the pull request is the measurement - one data point until step 4's real samples exist. Plan: `docs/plans/m3-step21-show-the-changed-files.md` (`Status: proposed`) | next |
| 10 | **Orphan subtitle cues.** `cuesForStep` filled lines greedily and paired them, so an odd line count left a trailing cue holding the remainder - "layer." for 415 ms, and 238 ms for "it." on a hand-written fixture. Fixed by taking the cue count from the text's length and splitting the words evenly: 4 cues under 1200 ms became 0, with the same 32 cues over three videos (ADR-040). Plan: `docs/plans/m3-step10-orphan-cues.md` | done |

## Milestone 4: GitHub integration

**Milestone 4 is built apart from step 5's object storage**, which needs an account and
credentials. A pull request in a service repository now gets a reviewed, narrated video and a
sticky comment from a workflow of ten lines, and the tool has posted on GitHub for real (ADR-056).

**Where the model runs in CI is decided: a self-hosted runner on a dedicated team machine, running
Ollama with the default model** (Bahman, answering Q2 of step 1's plan; ADR-051). It keeps ADR-015
whole. A hosted runner for a private repository has 2 CPUs and 8 GB and no GPU, which cannot hold
`qwen3:30b` and would make even `qwen3:4b` slow; the hosted API stays opt-in for whoever brings a
key. GitHub's advice is to use self-hosted runners with private repositories only, because whoever
can change a workflow runs code on the machine. Step 4 needs the machine to exist.

| Step | Scope | Status |
|---|---|---|
| 1 | `--pr` source (same ingest outputs as `--git`): the pull request and its diff from the GitHub REST API over `fetch`, public and private repositories, one clear line per GitHub failure. `read_file` and `grep_repo` only on a checkout whose `HEAD` is the reviewed head, for `--git` too - which in CI needs `actions/checkout` with the head sha, not its default merge commit. The end-to-end run of all nine samples came first: six videos, three correct no-video runs, and two defects in the script that measures it, fixed (ADR-051). Plan: `docs/plans/m4-step1-pr-source.md` | done |
| 2 | `spr stage publish`: the sticky PR comment. Renders `comment.md` - every finding's reasoning and fix as text, permalinks at the head, model text made inert - and `spr run` stops there; posting is its own command, which updates the comment an earlier run posted. A forced run clears its own earlier outputs, so no stale video is ever linked. Commit comments for pushes moved to step 4 (ADR-052). The first post against the real API moves to step 4 too, where Actions provides the token: `spr-publish-test` is pushed as its fixture. Plan: `docs/plans/m4-step2-publish.md` | done |
| 3 | Tool Docker image published to GHCR: `node:22-bookworm-slim` plus ffmpeg and the headless shell, 1.67 GB, built and smoke-tested by `.github/workflows/image.yml` before it publishes. Containerizing found a real defect: the picture's length depended on the installed ffmpeg's handling of `-shortest`, and the Composer now states it with `-t` (ADR-053). Plan: `docs/plans/m4-step3-docker-image.md` | done |
| 4 | Workflow for service repos: `video-review.yml` is reusable (`workflow_call`), `self-review.yml` is this repository calling it. Checks out the pull request's head, waits for Kokoro, skips drafts, opted-out pull requests and pushes a pull request already covers, uploads the video and posts the sticky comment with its artifact URL; a fork says once that its token cannot post. **Publish has met the live API**: a push posted a commit comment as `github-actions[bot]`, with working permalinks and the video link (ADR-056). Four runs to get there, three of them on defects the image and the workflow only show in CI. Plan: `docs/plans/m4-step4-workflow.md` | done |
| 5 | Video hosting. **The artifact half is built and live** (ADR-056): the workflow uploads `final.mp4` and the comment links it. What that link gives a reviewer is a signed-in zip download, not a video that plays - which is ADR-008's own reason for option 2, S3-compatible storage with a presigned URL. That needs an account, a bucket and credentials, so it waits on Bahman; nothing else in the milestone does | planned |

## Milestone 5: polish

Subtitles styling, voice and theme options, docs for service teams,
composite or reusable workflow.

Intro and outro cards used to be listed here, and are **withdrawn, not deferred**: Bahman decided
a video is findings only, and considered and rejected the reason the outro card existed - that
a viewer could pause on it and screenshot it into the pull request (ADR-042). Do not re-add
them as polish.

## How to work on a step

1. Read CLAUDE.md, this file, and the relevant docs and ADRs.
2. If there is no plan in `docs/plans/` for the step, write one (scope, files, contracts,
   tests, open questions) and get it approved before writing code.
3. Implement inside the step's scope. Contract changes follow CLAUDE.md (schema, generated
   types, fixtures, ADR together).
4. `pnpm verify`, `pnpm format:check` and `pnpm build` pass; CI is green after push.
5. Update the status here, and add an ADR for any decision with lasting effect.
