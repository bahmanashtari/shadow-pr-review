# Plan: Milestone 3, step 8 (a sync check that can fail)

Status: approved, with all four recommendations in section 3 taken unchanged - the Composer
probes the webm rather than the Recorder (Q1), `record.json` gains no field (Q2), a short
recording fails and hands over (Q3), and the tolerance is 40 ms (Q4). Written at the end of the
session that ran Milestone 2 end to end, so the diagnosis in section 1 is that session's
measurement rather than a reconstruction. Read CLAUDE.md, docs/ROADMAP.md and ADR-031 to
ADR-034 first.

## 1. The defect, which is already diagnosed

`assertInSync` in `src/composer/compose.ts` compares the final file's video stream against its
audio stream. `-shortest` in `ENCODE` ends the output when the shorter *input* ends, so by the
time those two streams exist the encoder has already forced them into agreement. The check can
only ever measure frame granularity, and it reports that as a sync figure.

It is not theoretical. Two run folders are on disk with the same timeline (56 637 ms), the same
clips (55 037 ms in four) and the same `t0` (134 ms):

| | `runs/m2s2-sample-01` (step 5) | `runs/e2e-sample-01-order-outbox` |
|---|---|---|
| `recorded_duration_ms` | 56 638 | 56 642 |
| the `video.webm` on disk | **55.960s** | 56.640s |
| `final.mp4` audio | **55.808s** | 56.2368s |
| against the timeline's 56.237s | **429 ms short** | exact |
| what the check said | "8 ms apart" | "77 ms apart" |

Playwright wrote a webm 678 ms shorter than the Recorder's own clock claimed. The trim took
`t0` off the front, the video input came out shorter than the audio input, and `-shortest` cut
the narration to fit. The step-5 `final.mp4` ends mid-signal with no trailing silence, where
Kokoro pads every clip with 359.958 ms of it - the last word of "Good work on the rest of the
implementation" is gone. The check passed with the best number the project has recorded.

Three of three runs in the end-to-end session came out exact and the one run at step 5 came out
truncated, so it is intermittent. That is the argument for the check, not against it.

## 2. What it does

Two checks, against fixed references rather than against each other:

**In the Composer.** Compare the final file's audio against `timeline.total_duration_ms` - what
the audio was *scheduled* to be - and fail when it falls short. On the bad run that is 429 ms
against a tolerance that can now be tight, because both sides are known numbers rather than two
measurements of the same encode.

**In the Recorder.** Probe the `video.webm` it just wrote and compare it against the duration it
measured on its own clock, so a short recording is named at the stage that produced it instead
of being inferred two stages later from a truncated mp4.

## 3. Decisions to take

**Q1. Does the Recorder gain an ffprobe dependency? Recommendation: no - the Composer probes the
webm.**

ADR-031 is explicit that steps 1 to 4 need neither ffmpeg nor ffprobe, because Playwright brings
its own ffmpeg for the WebM and the real one is the Composer's dependency. Making the Recorder
probe its own output would overturn that for a diagnostic. The Composer already has ffprobe and
already reads `record.json`, so it can compare all three numbers - the webm's real duration,
`recorded_duration_ms`, and the timeline - and say which pair disagrees. The Recorder keeps
reporting what its clock saw.

That costs the Recorder's own test coverage of the condition, which is the honest trade: the
diagnosis lands one stage later than where the fault occurred, but no new dependency crosses
ADR-031's line.

**Q2. Does `record.json` gain a field for the webm's measured duration? Recommendation: no.**

It would be a contract change - schema, generated types, golden fixtures and an ADR together -
for a number the Composer can measure itself at the moment it needs it, and that nothing
downstream of Compose reads. A contract with no reader is how schemas start being written for
their own sake (ADR-033's wording, and it applies here).

**Q3. Is a short recording a failure or a warning? Recommendation: a failure that hands over.**

A video with the end of the narration cut off is not something to ship with a note. It should
fail the stage, keep the run folder, name the three numbers and their differences, and say that
`spr stage record --run <dir>` re-records - which is the established shape for a stage that
cannot finish (ADR-024's `script.rejected.json`, and the reason the CLI prints one clear line
and a pointer to `trace.jsonl`). Recording is real time and non-deterministic, so a re-run is a
real remedy rather than a formality.

Deliberately not in scope: retrying the recording automatically. It would hide the intermittency
this step exists to surface, and it is a separate decision about how many real-time minutes a run
may spend.

**Q4. What tolerance? Recommendation: one video frame, 40 ms, on the audio-versus-timeline
check.**

The audio track is built by the Composer from clips it measured, so it should match the timeline
to the millisecond, and it did on three of three good runs (0.2 ms, 1.0 ms, 0.7 ms). A tolerance
of 40 ms is thirty times the largest good observation and ten times smaller than the smallest
bad one. `MAX_DRIFT_MS` at 250 was sized for the old comparison and should not be reused for
this one; keep it for the frame-granularity figure if that is still worth reporting.

## 4. Files

- `src/composer/compose.ts`: `assertInSync` replaced or joined by a check against the timeline;
  the webm probe and the three-way comparison; the error text.
- `test/composer/compose.test.ts`: the truncation case, which needs a fixture rather than a real
  recording - a short webm plus a timeline that expects more is enough, and neither needs
  Chromium.
- `src/composer/ffmpeg.ts`: nothing new expected; `streamDurationMs` already does the probing.

## 5. What to check

- The bad run reproduces the failure: `pnpm spr stage compose --run runs/m2s2-sample-01` should
  now fail, naming 429 ms. **`runs/` is git-ignored, so that folder exists only on the machine
  that ran Milestone 2 step 6** - it is a one-off check to run before touching the code, not a
  committed fixture, and it will be gone on any other checkout. The suite's coverage has to come
  from the synthesized short webm in section 4 either way; a 2.6 MB recording does not belong in
  the repository.
- The three good runs still pass: `runs/e2e-sample-*`.
- The message says which pair disagrees, because a short webm and a mismeasured clip point at
  different stages.

## 6. Documentation

- `docs/ROADMAP.md`: step 8 done.
- `CLAUDE.md`: the warning added in ADR-034's commit ("do not read the Composer's line as a sync
  guarantee") comes out again, replaced by what the check now guarantees.
- `docs/DECISIONS.md`: an ADR, because the tolerance and the Q1 ruling both outlive the change.

## 7. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. `pnpm tsx scripts/end-to-end.ts`, which is now the thing that would have caught this.
3. Commit, push, check CI.
