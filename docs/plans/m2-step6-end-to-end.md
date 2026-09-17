# Plan: Milestone 2, step 6 (end to end)

Status: proposed, and written at the end of the session that built steps 1 to 5 - so the next
session can start by approving it rather than by reconstructing where things were left. Read
CLAUDE.md, docs/ROADMAP.md and docs/DECISIONS.md (ADR-027 to ADR-033) first.

Every stage now works. This step is the one that proves they work *together*, on every golden
sample, without anyone steering - and it is the first step whose real output is a judgement
rather than an artifact.

## 1. What it does

`spr run --diff golden/<sample>/diff.patch`, with no `--until`, for all three samples, producing
a watchable `final.mp4` each time.

That command has not been run to completion once. Steps 1 to 5 were each verified on their own
and step 5 was verified on `sample-01` only, by re-running single stages against a run folder
that had been built up over several hours. **Nothing has yet started from a bare diff and come
out the other end as a video**, which is exactly the kind of gap that hides an ordering bug or a
missing file.

## 2. What is known to be missing before it starts

Two things this step inherits, both found and left deliberately:

**The bare `spr run` path is no longer unit-tested.** Step 4 made recording real-time, so the
CLI test that used to exercise a full run without `--until` was changed to stop at `direct`
(about forty seconds of recording does not belong in a suite that finishes in four). The
unbuilt-stage assertion moved to `spr stage publish`. This step is where that path gets
exercised again, and Q1 below is about whether it also gets a test.

**The title card reads "Code review".** `scriptTitle` falls back to that when the source has no
title, which a `--diff` run never does unless `--title` is passed. It is correct behaviour and
it will be on all three videos, so it is worth looking at once there is something to look at.

## 3. Decisions to take

**Q1. Does this step add an automated end-to-end test? Recommendation: a script, not a test.**

The pull is obvious - the bare `spr run` path has no coverage. The problem is cost: a full run
records in real time, so three samples is several minutes of wall clock, plus a model call per
sample when the cache is cold. That belongs in neither `pnpm test` (four seconds today) nor CI
(sixty-six seconds today).

Recommendation: `scripts/end-to-end.ts`, run deliberately, which walks all three samples and
prints a table of what came out - duration, drift, findings, steps, file size. It is the thing
somebody runs before a release or after touching a stage boundary, and it prints numbers worth
comparing across runs rather than a pass or fail. If it later proves worth automating, a
scheduled CI job is the place, not the per-push one.

**Q2. Should the narration-length question (ADR-028) be settled here? Recommendation: measure,
but do not change the prompt.**

ADR-028 decided the Narrator needs a per-step target rather than only a cap, and the roadmap
carries it as Milestone 3 step 6. Its numbers are stale twice over: they predate ADR-029's
deduplication, which moved finding steps from 26-33 words to 39 against the fixtures' 44-60, and
they were taken before any complete video existed.

This step produces three complete videos, which is the first chance to judge length against
something watchable rather than a word count. Recommendation: record the measurement in this
step and leave the prompt change in Milestone 3, because a prompt change needs `spr eval` behind
it (ADR-025) and bundling it here would put two unrelated things in one commit.

**Q3. Should `--diff` runs get a better default title? Recommendation: decide after watching.**

Options are a filename-derived title, the review's own summary, or leaving it. It is a
one-line change in `scriptTitle` either way, and the right answer depends on how the generic
card actually looks on screen - which nobody has seen yet.

## 4. What to check on each video

The point of the step, and the part no assertion covers:

- The narration matches what is highlighted, the whole way through. A drift here would mean the
  Director and the Recorder disagree about time, and 8 ms of measured drift on `sample-01`
  suggests they do not - but one sample is not three.
- Subtitles are readable and in step with the voice.
- The title card, the transitions and the outro card look deliberate rather than accidental.
- `sample-03` has one finding, so its video is about 25 seconds. Watch specifically whether that
  reads as "short and to the point" or as "something went wrong".

## 5. Prerequisites, which this step needs all at once

The first step that needs the entire toolchain up simultaneously:

```bash
source ~/.nvm/nvm.sh && nvm use          # node 22; the default node 18 cannot run pnpm 12
ollama serve                              # with qwen3:30b pulled
open -a Docker                            # then: docker compose -f docker/compose.yml up -d kokoro
ffmpeg -version                           # installed at step 5
pnpm exec playwright install chromium-headless-shell   # installed at step 4
```

Expect several minutes of wall clock: recording is real time, so the three videos take roughly
as long as the videos are.

## 6. Documentation

- `docs/ROADMAP.md`: step 6 done, and Milestone 2 complete.
- `CLAUDE.md`: the end-to-end script, and a line saying `spr run` with no `--until` now goes all
  the way to `final.mp4`.
- `docs/DECISIONS.md`: an ADR if the run turns something up, which on this project's record it
  probably will - every step from 1 to 5 found something that only appeared when the thing was
  actually run or watched.

## 7. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. All three samples end to end, and **watch all three with the sound on**.
3. Record the narration-length measurement against `docs/NARRATION_STYLE.md`'s target.
4. Commit, push, check CI.
5. Report, and say plainly which of the three videos is the weakest and why - the useful output
   of this step is a judgement, not a green tick.
