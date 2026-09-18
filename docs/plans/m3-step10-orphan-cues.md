# Plan: Milestone 3, step 10 (orphan subtitle cues)

Status: approved, both recommendations taken unchanged - fix the cause with a balanced split
(Q1), and assert the minimum duration in tests rather than clamping in code (Q2). Read CLAUDE.md, docs/ROADMAP.md and ADR-033 and ADR-034 first. Small and
self-contained: pure arithmetic in one module, no model, no services beyond ffmpeg, and the fix
has already been prototyped against the three recorded videos (section 3).

The last open defect from the first complete run. ADR-034 named three things to look at; the
severity contradiction is closed (ADR-038) and the static cards are Milestone 5's, so this
finishes that thread.

## 1. What is wrong

`cuesForStep` wraps a step's text greedily to 42 characters, groups the lines in pairs, and
divides the step's window between the groups in proportion to how much text each carries. The
arithmetic is right and the proportion is right. The problem is what greedy filling leaves at
the end: a trailing group holding one short line.

Measured on the three videos ADR-034 watched:

| duration | text | where |
|---|---|---|
| **415 ms** | `layer.` | sample-01 S02 |
| 941 ms | `implementation.` | sample-01 S03 |
| 1025 ms | `before merging.` | sample-01 S00 |
| 1036 ms | `updates atomic.` | sample-02 S02 |

Every one is a trailing group carrying 6 to 15 characters where its siblings carry 69 to 85. A
single word on screen for 415 ms is a flash, not a subtitle. `sample-03` has none, which is why
it read as the cleanest of the three.

## 2. Decisions to take

**Q1. Fix the cause or clamp the symptom? Recommendation: fix the cause.**

Two ways to go:

*Clamp.* Give every cue a minimum duration, borrowing the difference from the cue before it.
`layer.` would show for 800 ms and its predecessor would shorten from 5315 to 4930. Three lines
of code, and the orphan is still an orphan - one word alone on screen, just for longer.

*Fix the cause.* Choose the number of cues from the text's length first -
`ceil(chars / (MAX_LINE_CHARS * MAX_LINES))` - then split the words as evenly as that many cues
allow, widening to another cue if any group would need three lines. No group is then a
remainder, so proportional timing has nothing lopsided to be proportional to.

Prototyped against all fourteen steps of the three recorded videos:

| | greedy (today) | balanced |
|---|---|---|
| cues under 1200 ms | **4** | **0** |
| shortest cue | 415 ms | 2890 ms |
| longest cue | 5870 ms | 5189 ms |
| cues per step | unchanged | unchanged |

It costs no extra cues, and it tightens the long end too, because the same text spread evenly
never has to carry 85 characters in one cue.

**Q2. Does the minimum duration become a check in code, or an assertion in tests?
Recommendation: tests.**

A clamp in production code would be dead logic once the cause is fixed. The window is measured
audio *for that very text* (ADR-027), so the duration of a cue is bounded below by the speaking
rate: a cue holding 55 characters cannot be handed 400 ms, because 55 characters take about two
seconds to say. There is no reachable state for the clamp to catch, and unreachable defensive
code is a claim nobody can check.

What is worth having is the property asserted where it can be seen to hold: a test over the
golden fixtures' own scripts that no cue falls under a floor. That fails loudly if the splitting
ever regresses, and it documents the number.

## 3. Files

- `src/composer/srt.ts`: `cuesForStep` chooses its cue count and splits evenly; `wrapLines` is
  untouched, since wrapping a cue's own text to two lines is still exactly what it does.
- `test/composer/srt.test.ts`: the split, the widening case, and the minimum-duration property
  over the golden scripts.

## 4. What to check

- No cue under the floor on any golden script, which is the defect.
- Every cue still wraps to at most two lines, which is what stops subtitles covering the code.
- Cue count per step does not grow, so the change is not buying legibility with churn.
- `sample-03` still has no orphans - it did not have the bug and must not acquire one.

## 5. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. Regenerate `subtitles.srt` for a recorded run (`spr stage compose`) and read it, since the
   output is judged by eye and this ffmpeg cannot burn subtitles in (ADR-033).
3. An ADR if the arithmetic turns out to want a ruling; the numbers above may be enough on their
   own.
4. Commit, push, check CI.
