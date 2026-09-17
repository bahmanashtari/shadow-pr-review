# Plan: Milestone 2, step 2 (the Director)

Status: done. Implemented in "Milestone 2 step 2: the Director", with all three questions
decided as recommended. Read CLAUDE.md, docs/ROADMAP.md, docs/ARCHITECTURE.md (section "2. Stages",
subsections 6 and 7), `schemas/timeline.schema.json`, `checkTimeline` in
`src/contracts/checks.ts`, and docs/DECISIONS.md (ADR-005, ADR-027) first.

This step is where measured audio becomes a schedule. Step 1 produced the durations; this turns
them into `timeline.json`, the single file the Recorder executes and the Composer lays audio
and subtitles against. It is the second half of CLAUDE.md principle 1 - script first, render
second - and the last stage before anything is drawn on a screen.

It is also the easiest stage in the pipeline to get right, because it is arithmetic. There is no
model, no network, no subprocess and no I/O in the part that matters: `buildTimeline` is a pure
function of `(script, manifest, config)`, which is exactly what CLAUDE.md asks for ("Pure
functions for the Director and SRT generation; unit test them without I/O").

## 1. What it does

Input: `script.json` and `audio/manifest.json`. Output: `timeline.json`.

Windows come first. Each step's window is `[start, start + clip duration]`, and the next step
starts one `gap_ms` after the previous one ends. `checkTimeline` already enforces exactly that
(`start_ms === prev.end_ms + gap_ms`) and that each window's length equals its clip's
`duration_ms`, so the contract pins the arithmetic and the tests can be about the edges.

Actions hang off the windows, per ARCHITECTURE section 6:

| Step kind | Actions |
|---|---|
| `intro` | `show_title` at window start, `hide_title` at window end |
| `finding` | `open_file` and `scroll_to` at the lead-in, `highlight` at start, `clear_highlight` at end |
| `wrap_up` | `show_outro` at window start |

`open_file` is skipped when the previous finding step was already in that file, so the page does
not re-open a file it is already showing.

Nothing here is a judgement call, so nothing here is a model.

## 2. Files

```
src/director/timeline.ts    # pure: buildTimeline(script, manifest, config) -> Timeline
src/director/direct.ts      # the stage: read the two files, write timeline.json
```

The same split as `src/verify/` (grounding vs stage) and `src/tts/` (normalize/duration vs
stage): the arithmetic is testable on its own, and the file handling is a thin shell over it.

`readManifest(runDir)` joins `readScript` and `readReview` as a validated reader, and it belongs
in `src/tts/speak.ts`, which already owns `MANIFEST_FILE` - the same way `readScript` lives with
`SCRIPT_FILE` in `src/agents/narrator.ts`.

## 3. The lead-in, which is the only interesting number

ARCHITECTURE says `open_file` and `scroll_to` fire at `start - 300 ms`, "clamped". Two clamps
are needed and only one of them is obvious.

- **Clamp to 0.** The intro is the first step, so nothing scrolls before it, but a script with
  no intro would otherwise produce a negative `at_ms` that the schema rejects.
- **Clamp to the previous step's `end_ms`.** This one is not in ARCHITECTURE and should be. The
  lead-in is meant to land in the silence between two steps, and it does at the default
  `gapMs` of 400. But `config.video.gapMs` has `minimum: 0`, and at any gap under 300 the
  lead-in slides back *inside the previous step's window* - so the page would scroll away from
  the code while that step's narration is still being spoken. Clamping to the previous end
  makes the lead-in "as early as possible without stepping on the previous step", which is what
  it was always trying to express.

`checkTimeline` requires actions sorted by `at_ms`, so the sort has to be stable: several
actions legitimately share a timestamp (one step's `clear_highlight` and, at a zero gap, the
next step's `open_file`). Emitting in step order and using a stable sort keeps the Recorder
executing them in the order they were meant.

## 4. Decisions to take

**Q1. Does the Director read `ingest.json`? Recommendation: no.**
ARCHITECTURE section 2 says "The Verifier, Director and Recorder use only this API [HunkIndex]",
which implies it does. But every coordinate the Director needs is already in `script.json`:
`focus` is copied verbatim from a finding that the Verifier already grounded against the diff
(`hasRange`, `containsSnippet`), so re-checking it here would re-prove something proved upstream
and would make a pure function depend on a third file. CLAUDE.md's own layout line says what
this stage is - "script + manifest -> timeline". Recommendation: take `script` and `manifest`
only, and correct that sentence in ARCHITECTURE to name the Verifier and Recorder.

**Q2. Where does `render_mode` come from? Recommendation: hardcode `diff2html`.**
The schema allows `diff2html` or `github`, and ADR-005 makes diff2html the default with GitHub
mode "optional". There is no `video.renderMode` in the config schema today. Adding one now would
be a switch with one working position, for a renderer that does not exist. Recommendation: emit
`"diff2html"`, and add the config field in the same change that builds GitHub mode, if it is
ever built.

**Q3. Does the video stop on the last syllable? Recommendation: no - add one `gap_ms` tail.**
ARCHITECTURE section 7 has the Recorder wait until `total_duration_ms` before closing, so this
field is the video's length. Setting it to the last window's `end_ms` cuts the recording the
instant the last word finishes, which reads as a glitch rather than an ending. Recommendation:
`total_duration_ms = last end_ms + gap_ms` - it gives the outro card a beat to be read, it is
consistent with the pause between every other step, and it reuses a knob that already exists
instead of adding one. `checkTimeline` only requires `total >= last end_ms`, so this is legal.

## 5. Tests

`test/director/timeline.test.ts`. No I/O in any of them; the stage's file handling gets a couple
of CLI tests like every other stage.

- windows: start at 0, each length equals its clip's `duration_ms`, each start is the previous
  end plus `gap_ms`, and `checkTimeline(timeline, manifest)` returns no problems.
- actions: the intro gets `show_title`/`hide_title`, a finding gets the four it should, the
  wrap-up gets `show_outro`, and every action's `step_id` has a window.
- `open_file` is skipped for a run of consecutive steps in one file, and re-emitted when a
  later step returns to a file after visiting another.
- the lead-in: 300 ms early at the default gap; clamped to 0 for a first step; clamped to the
  previous `end_ms` at `gapMs: 0`, with a test that names why.
- actions come out sorted by `at_ms`, including when several share one.
- `total_duration_ms` covers the last window plus the tail.
- a script with no findings (intro + wrap-up only) produces a valid timeline - the clean-change
  path the Narrator already supports must not fall over here.
- every golden script, spoken by the fake provider, directs into a timeline that passes
  `checkTimeline` and its schema. This is the `GOLDEN_SAMPLES` loop the other stages have.
- determinism: same inputs, byte-identical output.

**No `golden/*/timeline.expected.json`.** `contractFromFileName` anticipates the name, but a
committed timeline would be keyed to real measured audio and would change whenever Kokoro's
version, the voice or the narration did - a fixture that has to be regenerated to stay passing
is a fixture that stops being read. The fake provider's durations are a pure function of word
count (ADR-027), so the golden loop above gets determinism without that cost.

## 6. CLI

`spr run --until direct` and `spr stage direct --run runs/<id>`, following the shape the other
stages already have: the stage reads `script.json` and `audio/manifest.json` back off disk, so
`run` and `stage` take the same path, and a hand-edited script (ADR-024) still directs.

`spr run` with no `--until` then stops after `direct`, pointing at Milestone 2 step 3.

## 7. Documentation

- `docs/ROADMAP.md`: step 2 done, step 3 next.
- `CLAUDE.md`: the `direct` commands, and `timeline.json` in the run-folder listing.
- `docs/ARCHITECTURE.md`: the lead-in clamp in section 6, and the HunkIndex sentence in
  section 2 if Q1 goes as recommended.
- `docs/DECISIONS.md`: an ADR only if Q1, Q2 or Q3 is decided against the recommendation, or if
  building it turns up something the way the streaming WAV header did in step 1. Three small
  arithmetic choices with reasons in the code do not need one each.

## 8. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. `spr run --diff golden/sample-01-order-outbox/diff.patch --until direct` and read the
   timeline against the clip durations by hand - the last chance to catch an off-by-one before
   a Recorder starts acting on these numbers.
3. Commit, push, check CI.
4. Report. Do not start step 3.
