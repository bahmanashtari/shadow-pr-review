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
| `diff.patch` | The change under review, as a unified diff. A sample that adds files applies to an empty tree; one that modifies them is a diff against code that does not live here, so it parses and scores but does not apply. |
| `labels.json` | Ground truth for evals: issues that MUST be found and things that MUST NOT be flagged, and where the change came from. Validates against `schemas/labels.schema.json`. |
| `review.expected.json` | An ideal `review.json` (after the Verifier). Validates against `schemas/review.schema.json`. |
| `script.expected.json` | An ideal `script.json`. Validates against `schemas/script.schema.json`. |

## Real and synthetic samples

Every `labels.json` must say `"origin": "real"` or `"origin": "synthetic"`, and `spr eval`
totals the two separately.

A **synthetic** sample is written from a known bug pattern by whoever is building the tool. It
measures whether the Reviewer recognises a bug somebody put there for it to find. A **real**
sample is an anonymized change from a service that actually runs, and its bug is one that a
person had to catch - or did not. Only the second supports a claim about production code, so the
two are never averaged into one rate that would read like the stronger claim.

The field is required rather than optional-and-defaulted on purpose: a flag that can be left off
gets left off, and the sample it is forgotten on is exactly the one whose score somebody quotes.

Anonymising a real change means renaming services, bounded contexts, tables, columns, event
names, config keys, hosts, people and ticket ids, and removing comments that describe the
business. What must survive is the shape of the code, because that is what is being measured.
This repository is public, and git keeps what it is given, so a sample is reviewed before it is
committed rather than after.

## Contributing a real sample

The seven samples here are synthetic, so they only say whether the Reviewer finds bugs that were
written for it. A real sample says whether it finds the bugs a team actually writes, which is the
claim this tool exists to make. Nobody needs to write JSON to contribute one.

**What to supply**: a diff and a few lines of notes. The four files in the sample folder are
written from those, and the notes' author checks `labels.json`, because the ground truth has to
be theirs.

**Where to find one**, in a service repository on the target stack:

```bash
git log --oneline -i -E --grep="fix|hotfix|revert|bug" --since="1 year ago"
```

Each hit is a fix, and the sample is the change that **introduced** the bug, not the fix. `git
blame <fix-sha>^ -- path/to/file.ts` shows which commit last wrote the lines the fix changed.
Pull requests where a reviewer caught a bug before merge are as good - the diff before the review
fix is the sample - and so are reverted commits. One or two changes where nothing was wrong are
worth having too, because restraint is scored. Most wanted: anything where a message, event,
webhook or job was processed twice; then migrations, authorization and money.

**Exporting it**: `git show <sha> > ~/spr-incoming/01-refund-consumer.patch` for a commit, or
add `.diff` to a GitHub pull request's URL. Keep it under about 300 changed lines; lockfiles and
generated files are filtered out anyway.

**The notes**, beside it as `01-refund-consumer.txt`:

```
Bug: RefundRequested consumer refunds without checking for an existing refund.
     After a pod restart the broker redelivered it and we refunded twice (incident).
Where: refund-requested.consumer.ts, the handle() method.
Severity: critical - money went out twice.
Also: someone might flag the missing DTO validation; that's real but minor.
```

**Keep both outside this repository** until they are anonymised - see the anonymisation rules
above. The repository is public, and git keeps what it is given.

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
  reached a script. A sample whose verified review kept nothing has nothing to narrate
  (ADR-042): it is reported as such, not as a failure, and left out of the narrated total.
  Compare wording and tone by reading, not by scoring.

### Writing `accept_categories`

An alternative category is a hole as well as a courtesy, and this set has fallen through it
twice. When two labelled bugs share lines, a finding about one of them can match the other's
label through a category both could be filed under, and the scorer cannot read the finding to
tell. `sample-02`'s redelivery label accepted `event-consistency` until ADR-041 and `correctness`
until ADR-044, and each time the model's finding about the neighbouring atomicity bug counted as
having found redelivery.

So: on lines another label shares, accept only categories that bug could not plausibly be filed
under, and never the catch-all `correctness`. The categories are defined in
`docs/REVIEW_RUBRIC.md`, which the Reviewer reads too, so a label and a finding are held to the
same definitions. A real finding filed under the wrong heading is not lost by being strict: the
report names the label it sits on as a near miss.

`labels.json` has a schema (`schemas/labels.schema.json`); `pnpm spr validate golden/*/labels.json`
checks every sample.

## Samples

All seven are synthetic. Real ones are still owed - see Milestone 3 step 4 in the roadmap.

1. `sample-01-order-outbox`: event published inside a DB transaction (no outbox),
   application layer coupled to TypeORM, untyped event contract.
2. `sample-02-inventory-consumer`: non-idempotent event consumer, partial updates,
   unsafe NOT NULL migration, empty `down()`.
3. `sample-03-email-value-object`: a mostly clean change. Tests restraint: one low
   finding only, plus a false positive the Verifier must drop.
4. `sample-04-payment-webhook`: an unsigned payment webhook that credits a wallet, and
   credits it again on every redelivery while the event id sits unused in the payload.
5. `sample-05-summary-projection`: a read model that double counts on replay, and a
   migration that drops a column outright. No analyzer fires here, so both required
   findings are the model's to earn.
6. `sample-06-customer-search`: SQL built by interpolation, and a new route left without
   the guard its neighbour carries. The only sample whose diff modifies files rather than
   adding them, so the authorization problem is visible only in a context line.
7. `sample-07-retry-backoff`: a good change with one subtle remark (no jitter) and two
   tempting wrong answers. The harder restraint test of the two.

Three samples carry a redelivery or replay bug as a `must_find` - 2, 4 and 5 - deliberately in
different shapes: a broker consumer, an HTTP webhook and a projection replay. ADR-041 found the
Reviewer had never once reported one, and a single case could not say whether that was a blind
spot or an accident.
