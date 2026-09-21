# Plan: Milestone 3, step 7 (score redundancy in `spr eval`)

Status: **done, 21 September 2026**, taken under Bahman's instruction to "continue with whatever
else you can" while the real golden samples are outstanding. Eval-only, so it could not change a
review, a script or a video. Built as written; re-scoring every review on disk found only the
duplicate ADR-029 heard (ADR-048). Read ADR-025, ADR-029 and ADR-036 first.

## 1. The gap

ADR-029: `sample-01`'s video had three finding steps for two problems, and the narration said so
aloud - *"This is the same problem as the previous one."* The analyzer had emitted one finding per
matching line. `spr eval` scored the sample 1.000 / 1.000 before the fix and after it, because
every metric scores findings one at a time: both duplicates matched the one label, recall counted
the label once, and precision counted both findings as true.

ADR-029 fixed that cause in the analyzer and left the blind spot, noting that scoring redundancy
"would need its own axis, in the shape ADR-025 gave restraint".

## 2. The decision

**Two kept findings that locate the same label are redundant**, and the extra ones are reported.
The test is the label, not the text: the scorer cannot read two findings and see they say the same
sentence, but it can see that two findings landed on one known issue. It uses `locates` - file,
overlapping lines and an accepted category - so severity plays no part, as in precision.

- Per sample: `redundant`, a list of labels located more than once, each with the ids of the
  findings that located it.
- Totals: `redundant`, how many findings were surplus - for a label located three times, two.
- Reported beside precision, never inside it, like `within_budget` (ADR-025) and `calibrated`
  (ADR-036): every finding can be true and there can still be one too many of them.
- Printed as a detail line under the sample, and as a column in the model comparison.

**What it cannot see**: two false positives making the same claim, since neither has a label to
land on. Those are already false positives, and the report already lists both.

## 3. Scope

- `schemas/eval.schema.json`: `ReviewScore.redundant` and `Totals.redundant`, both optional so an
  older `eval.json` still validates; `pnpm gen:types`.
- `src/eval/score.ts`: computed in `scoreReview`, summed in `total`.
- `src/eval/report.ts`: the detail line and the comparison column.
- Tests: ADR-029's own case - two findings on `application-depends-on-orm` - reads as one
  redundant finding; a finding that locates two labels is not redundant; a sample with nothing
  redundant reports an empty list.

## 4. What to check

- `pnpm verify`.
- Re-score the last runs from cache. The expectation is zero redundant findings on the default
  model today, because ADR-029 fixed the one known cause; a non-zero count is a finding worth
  reading.
