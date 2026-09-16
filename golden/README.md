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
| `labels.json` | Ground truth for evals: issues that MUST be found and things that MUST NOT be flagged. |
| `review.expected.json` | An ideal `review.json` (after the Verifier). Validates against `schemas/review.schema.json`. |
| `script.expected.json` | An ideal `script.json`. Validates against `schemas/script.schema.json`. |

## How to score

- **Recall**: a `must_find` item counts as found when a kept finding has the same file,
  an overlapping line range, the same category (or one listed in `accept_categories`),
  and severity >= `min_severity`.
- **Precision**: a kept finding is a true positive if it matches a `must_find` item or an
  `acceptable` item; anything matching `must_not_flag` is a hard false positive.
- **Narration**: each step <= 60 words, no markdown, no raw file extensions, intro first,
  wrap-up last. Compare against `script.expected.json` for tone, not for exact wording.

## Samples

1. `sample-01-order-outbox`: event published inside a DB transaction (no outbox),
   application layer coupled to TypeORM, untyped event contract.
2. `sample-02-inventory-consumer`: non-idempotent event consumer, partial updates,
   unsafe NOT NULL migration, empty `down()`.
3. `sample-03-email-value-object`: a mostly clean change. Tests restraint: one low
   finding only, plus a false positive the Verifier must drop.
