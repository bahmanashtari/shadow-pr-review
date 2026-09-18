# Plan: Milestone 3, step 4 (a golden set that can tell things apart)

Status: proposed, written at the end of the session that built Milestone 3 steps 1 and 6 to 12,
so the next session can put its questions to Bahman and start rather than reconstruct why this is
next. Read CLAUDE.md, docs/ROADMAP.md, `golden/README.md`, and ADR-025, ADR-026, ADR-036 and
ADR-041 first. **Do not rewrite this plan; amend its status when it is approved.**

## 1. Why this is next

Three samples cannot say much any more, and this session proved it three ways:

- **ADR-026**: three of four local models tied at 1.000 precision and recall. The set had run out
  of discrimination, and the analyzers supply two of the four `must_find` items for every model.
- **ADR-036**: over-rating severity was invisible until a calibration axis existed - and with it,
  the whole set holds exactly *one* calibration case. One case shows a mechanism works; it cannot
  establish a rate.
- **ADR-041**: recall had read 1.000 since ADR-026 while the Reviewer was blind to a real bug.
  `sample-02`'s `non-idempotent-consumer` (a redelivered event decrements stock twice) has never
  been found in any run on disk - the model finds the neighbouring atomicity bug instead, and a
  label's `accept_categories` let one count as the other. Recall is now an honest 0.750.

So the one blind spot the project knows about is a serious production bug class, and the set is
too small to tell whether any change improves it.

## 2. What it does

Adds samples, and corrects the ones there are.

**New samples**, each a `golden/sample-NN-<name>/` folder with `diff.patch`, `labels.json`,
`review.expected.json` and `script.expected.json` (see `golden/README.md`). Every label carries a
`max_severity` as well as a `min_severity` from the start, so the calibration axis (ADR-036)
scores them.

**The existing fixtures are behind the format.** ADR-041 made the Reviewer write consequences and
named fixes, and the model's rationales now average 466 characters against the fixtures' 221 -
the first time the standard is *behind* the output rather than ahead of it. ADR-042 rewrote the
scripts; the `review.expected.json` rationales and suggestions were not rewritten, and should be,
so they describe what a good finding contains now.

## 3. Decisions to take

**Q1. Where do the new samples come from? This is the question only Bahman can answer.**

The roadmap has always said *real, anonymized changes from the team's services*, and that is
still the right answer: samples written by the model that is being evaluated measure its ability
to recognise its own idea of a bug. The session needs from Bahman:

- A handful of real diffs - merged pull requests that had a real bug caught in review, or that
  shipped one - from services on the target stack (NestJS, CQRS, TypeORM, event-driven).
- For each, what the bug actually was, which is the ground truth a label records.
- Permission and guidance on anonymisation: service names, table names, anything proprietary.

Recommendation: ask for **four to six**, prioritising at least two that contain a redelivery or
idempotency bug, since that is the named blind spot. If he cannot provide them this session, the
fallback is Q2.

**Q2. If real changes are not available yet, what then? Recommendation: hand-write samples from
known bug patterns, labelled as synthetic, and keep them separate.**

The rubric's own examples are a ready list - SQL injection, a committed secret, a destructive
migration, a missing authorization check, a consumer without dedupe. Samples written from those
are better than nothing and worse than real ones, and the report should be able to tell them
apart: a `"synthetic": true` field in `labels.json` (a contract change - schema, types, ADR)
lets `spr eval` report real and synthetic recall separately, so nobody later reads a synthetic
1.000 as evidence about production code.

**Q3. Should `review.expected.json` be brought up to the new format in the same step?
Recommendation: yes, but as its own commit first.** It changes no score - `spr eval` scores
labels, not expected reviews - so it can land before any new sample and be reviewed on its own.

## 4. What to check

- `spr eval` before and after, with the calibration column. The point is that the numbers
  *move* - a set where every model scores 1.000 is not measuring anything.
- Whether the Reviewer finds a redelivery bug in any new sample. If it still never does, that
  is the next rubric or prompt change, and it now has a set that can show it worked.
- Every new label passes `spr validate`, and every `review.expected.json` passes Verify
  unchanged (the existing golden-set test does this).

## 5. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. `spr eval` with the configured model, and ideally `--model` for the other installed local
   models, since ADR-026's comparison is exactly what this unblocks.
3. An ADR recording what the larger set says - especially about redelivery.
4. Commit, push, check CI.
