# Plan: Milestone 1, step 5 (the deterministic Verifier)

Status: done. Implemented in "Milestone 1 step 5: the deterministic Verifier"
(ADR-023). Both open questions were decided before implementation: `src/verify/`, and the full ordering rule with the
sample-02 fixture correction). Read CLAUDE.md, docs/ROADMAP.md, docs/ARCHITECTURE.md (section "3. Verifier")
and docs/DECISIONS.md (ADR-014, ADR-016, ADR-019, ADR-020, ADR-022) first.

This step turns `review.raw.json` into `review.json`: the file the Narrator is allowed to read.
It contains no model call at all. Every decision here is provable from `ingest.json`, which is
what makes it the stage that enforces CLAUDE.md principle 5 - grounded output only.

The Verifier *agent* (keep / downgrade / drop with a note) is Milestone 3 step 1 and is out of
scope. This step builds the first of the two layers ARCHITECTURE.md describes, and leaves a
seam for the second.

## 1. What it does

Input: `ingest.json` (for the `HunkIndex`) and `review.raw.json`. Output: `review.json`.

Each finding runs a fixed gauntlet, in this order, and the first failure decides its fate.
The order matters: a finding whose file is not in the diff cannot have its lines checked,
and a finding that fails grounding should not be compared against other findings.

| # | Check | How | Drop reason |
|---|---|---|---|
| 1 | The file is part of the reviewed change | `HunkIndex.hasFile` | `out_of_scope` |
| 2 | Every line of the range exists on the given side | `HunkIndex.hasRange` | `lines_not_in_diff` |
| 3 | Every evidence string appears verbatim in that file's diff lines | `HunkIndex.containsSnippet` | `claim_not_supported` |
| 4 | No other surviving finding says the same thing | same file, same category, overlapping range | `duplicate` |
| 5 | The list fits the cap | sort, then `review.maxFindings` (10) | `over_cap` |

Check 1 is not hypothetical: with `read_file` and `grep_repo` in hand (step 4), the model can
report a real problem in a file this change never touched. It is a correct observation and a
wrong thing to narrate, because the recorder has no diff rows to highlight. `out_of_scope`
says that precisely, and keeps it in `dropped` where an eval can still see it.

Duplicates keep the stronger finding: higher severity first, then higher confidence, then the
earlier id - which is the analyzer finding when an analyzer and the model collide, since
analyzer findings are merged first and carry verbatim evidence by construction (ADR-022).

`style_only` stays unused. Whether a finding is merely stylistic is a judgement call, so it
belongs to the agent layer in Milestone 3, not here.

**A check deliberately not added:** evidence does not have to fall inside `line_start..line_end`.
`golden/sample-01-order-outbox` F02 points at lines 19-20 and quotes the `typeorm` import from
line 2, which is exactly the right way to support that claim. A range check on evidence would
drop it.

## 2. Files

```
src/verify/grounding.ts   # pure: the gauntlet above, over HunkIndex; no I/O, no config
src/verify/verify.ts      # the stage: read raw, apply, sort, cap, write review.json, summarize
```

Approved. Named `grounding.ts` rather than `checks.ts` so it does not read as a second
`src/contracts/checks.ts`; grounding is the property it enforces.

`src/verify/verify.ts` exports `runVerify({ ingest, review, config })`, `readRawReview(runDir)`,
`writeVerifiedReview(runDir, review)` and `summarizeVerify(outcome)`, mirroring
`src/agents/reviewer.ts` and `src/ingest/ingest.ts` so the CLI treats every stage alike.
Milestone 3 adds `src/agents/verifier.ts` (prompt plus per-finding model call) and
`runVerify` calls it after the deterministic layer, on the survivors only.

## 3. What the stage preserves and what it sets

- **Ids stay as they are.** `F03` in `review.json` is `F03` in `review.raw.json`, whether it was
  kept or dropped. Renumbering would break the raw-to-final mapping that `trace.jsonl` and
  `spr eval` need, and would force the dropped list to be renumbered too to stay unique.
  Gaps in the kept list are the point: they say something was removed.
- **`verification` is set to `{ "status": "verified" }` only when the finding has none.** At
  this layer that claim means what it should: the lines exist and the evidence is verbatim. An
  existing verification is left untouched, so re-running the stage over a file the Milestone 3
  agent already downgraded does not erase its verdict.
- **`summary`, `source` and `stats` are copied unchanged.** The summary describes the change,
  not the findings, so it stays true even when findings are dropped. (If every finding is
  dropped the Narrator gets a review with an empty list and a summary that may still hint at
  risk - step 6's problem, noted here so it is not a surprise.)
- **Existing `dropped` entries are carried through** and the new ones appended, so the stage is
  idempotent: running it twice produces the same file.

Every dropped entry carries a `note` saying exactly what failed, for example
`evidence 2 of 3 does not appear in the diff: "await this.repo.save(order)"`, truncated to the
schema's 500 characters. That note is what makes a bad run diagnosable without a model.

## 4. Ordering and the cap

`review.schema.json` says findings are "ordered by severity (critical first), then by file and
line". `checkReview` only enforces the severity part today, and
`golden/sample-02-inventory-consumer/review.expected.json` has drifted: at equal severity it
lists the `interface/` consumer before the `infrastructure/` migration, which is the wrong way
round alphabetically.

Decision: sort by severity, then file, then line (the same comparator the Reviewer already
uses), extend `checkReview` to enforce the full rule so it cannot drift again, and fix the two
sample-02 fixtures - reorder the findings, renumber them `F01..F04` so the ids read in order as
a real run would produce them, and update the `finding_id`s in `script.expected.json` to match.
The alternative is a stable sort on severity alone, which leaves the fixtures untouched but
leaves the documented ordering unenforced and partly false.

The cap comes last, so a finding is only cut for space after everything unprovable is gone:
`config.review.maxFindings` (10) kept, the rest dropped as `over_cap` in the same order.
`checkReview` gains an optional `{ maxFindings }` so the stage can assert the cap it just
applied - the test ADR-016 asked for when step 5 landed.

## 5. CLI

```
pnpm spr run --diff change.patch --until verify      # ingest, review, verify; exit 0
pnpm spr run --diff change.patch                     # now stops after verify, exit 2, pointing at step 6
pnpm spr stage verify --run runs/<id>                # re-verify an existing run: no model, offline, instant
```

`spr stage verify` is the first stage that can be re-run with no network, no model and no cache:
it reads two files and writes one. That makes it the cheapest way to see the effect of a
threshold change on a finished run.

One summary line, in the shape the other stages use:
`3 findings kept, 2 dropped (1 lines_not_in_diff, 1 duplicate)`.

## 6. Tests

`test/verify/grounding.test.ts` and `test/verify/verify.test.ts`. No network, no model.

Each check fires, and - as in step 4 - each near-miss does not:

- file not in the diff drops; a file in the diff does not.
- a range that runs past the hunk drops; a range fully inside it does not; an `old`-side range
  on a deleted line is kept.
- paraphrased evidence drops; evidence differing only in indentation is kept (`normalizeSnippet`);
  evidence carrying a copied `19 + code` prefix is kept, and the same prefix with the wrong
  number drops (ADR-020).
- same file, same category, overlapping ranges: the weaker one drops, the stronger survives;
  same file, overlapping, *different* category: both survive (sample-01 F01/F02 prove this is
  the common case); same category, disjoint ranges: both survive.
- twelve findings become ten kept and two `over_cap`, and the two are the lowest severity.

Plus:

- ids are preserved; kept and dropped ids together are unique; `checkReview` passes with the cap.
- `verification` is added where absent and an existing `downgraded` verdict is left alone.
- running the stage twice produces byte-identical output.
- **Golden regression:** for all three samples, verifying `review.expected.json` against the
  sample's own ingest keeps every finding and drops nothing. Measured before writing this plan:
  8 of 8 findings pass `hasFile`, `hasRange` and every evidence string. If a future prompt,
  renderer or fixture change breaks grounding, this test says so.
- CLI: `--until verify` writes `review.json` and exits 0; a bare `run` exits 2 naming step 6;
  `stage verify` rewrites `review.json` in an existing run folder.

## 7. Documentation

- `docs/ROADMAP.md`: step 5 done, step 6 next.
- `docs/ARCHITECTURE.md` section 3: say which layer is built.
- `CLAUDE.md`: the new commands, and `src/verify/` in the repository layout.
- `docs/DECISIONS.md`: ADR-023 for the placement of the deterministic layer, the drop-reason
  mapping (in particular `out_of_scope` for a file outside the diff), stable ids, and the
  ordering rule with the sample-02 fixture correction.

## 8. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. Smoke run: `spr run --diff golden/sample-01-order-outbox/diff.patch --until verify` against
   local Ollama, output in the report.
3. Commit, push, check CI.
4. Report. Do not start step 6.
