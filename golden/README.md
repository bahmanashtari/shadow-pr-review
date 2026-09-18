# Golden set

Hand-labelled sample changes used to evaluate the Reviewer, Verifier and Narrator.
Each sample is independent (they are not meant to be read as one codebase).

Stack assumed by the samples: TypeScript, NestJS (with @nestjs/cqrs and
@nestjs/microservices), TypeORM, PostgreSQL, DDD layering, event-driven microservices.
If your services use Prisma or MikroORM instead of TypeORM, replace the samples'
persistence code with your real patterns; the labels stay the same.

## Files per sample

| File | Purpose |
|---|---|
| `diff.patch` | The change under review (unified diff, `git apply`-able). |
| `labels.json` | Ground truth for evals: issues that MUST be found and things that MUST NOT be flagged. Validates against `schemas/labels.schema.json`. |
| `review.expected.json` | An ideal `review.json` (after the Verifier). Validates against `schemas/review.schema.json`. |
| `script.expected.json` | An ideal `script.json`. Validates against `schemas/script.schema.json`. |

## How to score

`spr eval` implements exactly this; ADR-025 records the rulings the original wording left open.

- **Recall**: a `must_find` item counts as found when a kept finding has the same file,
  an overlapping line range, the same category (or one listed in `accept_categories`),
  and severity >= `min_severity`.
- **Precision**: a kept finding is a true positive when it matches a `must_find` or an
  `acceptable` item on file, overlapping lines and category. Everything else is a false
  positive.
- **Severity is not part of precision.** A finding at the right lines with the right category
  that under-rates severity has spotted the issue and misjudged it: nothing spurious was said,
  so it counts as precise and does not count as found. That keeps calibration - the known weak
  spot (ADR-015, ADR-018) - visible as a recall gap instead of hiding it in precision.
- **`must_not_flag` is a name, not a rule.** Those entries have no location to match on, and
  `missing-tests` is about code that is absent. The precision rule already catches such a
  finding; the list only lets the report say which known mistake was made. A false positive no
  entry describes is reported as `unlabelled`, which is the interesting case.
- **Dropped findings are not false positives.** A finding the Verifier removed never reached
  the viewer. Its `reason` is reported instead, because `claim_not_supported` and
  `out_of_scope` call for opposite fixes.
- **Undefined is not zero.** A sample with no `must_find` items has no recall (`-`) and adds
  nothing to the aggregate denominator; a run that kept nothing has no precision. Overall rates
  are micro-averaged over items, not averaged over samples.
- **`max_findings`**, where a sample sets it, is a restraint budget scored separately from
  precision: every finding can be defensible and there can still be too many of them.
- **Narration**: the deterministic rules (step length, no markdown, no file names, one step per
  finding in order, no severity word but the step's own finding's) are enforced inside the
  Narrate stage, which fails rather than writing a script
  that breaks them, so the eval does not re-check them. It measures what they do not constrain -
  steps, words and duration against `script.expected.json` - and records a sample that never
  reached a script. Compare wording and tone by reading, not by scoring.

`labels.json` has a schema (`schemas/labels.schema.json`); `pnpm spr validate golden/*/labels.json`
checks every sample.

## Samples

1. `sample-01-order-outbox`: event published inside a DB transaction (no outbox),
   application layer coupled to TypeORM, untyped event contract.
2. `sample-02-inventory-consumer`: non-idempotent event consumer, partial updates,
   unsafe NOT NULL migration, empty `down()`.
3. `sample-03-email-value-object`: a mostly clean change. Tests restraint: one low
   finding only, plus a false positive the Verifier must drop.
