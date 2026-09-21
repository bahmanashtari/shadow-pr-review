# Plan: Milestone 3, step 14 (evidence that spans lines)

Status: proposed, written in the session that expanded the golden set (ADR-044), while its model
comparison ran. Nothing here is built. Read ADR-019, ADR-020, ADR-044 and CLAUDE.md principle 5
first. ADR-020 is the precedent that matters: `containsSnippet` already forgives one citation
habit - a copied `12 +` line-number prefix - and verifies it rather than trusting it. Option A
below is the same move for a second habit.

## 1. What happened

On `sample-05-summary-projection`, under the category guide, the Reviewer found the replay bug,
filed it correctly as `idempotency`, rated it high - and Verify dropped it as
`claim_not_supported`. Its one evidence string was five lines of a SQL template literal joined
into one:

```
await this.dataSource.query(`UPDATE order_summary SET orders = orders + 1, revenue = revenue + $2 WHERE custom...
```

The finding was right and grounded in real code. It was lost to the shape of its quote.

**How often: once.** Across every `review.json` under `runs/`, this is the only distinct
evidence string ever dropped as `claim_not_supported`. The case for the step is that one
observation plus a prior - multi-line SQL in template literals is ordinary in TypeORM code, so the
shape will recur on real changes - not a measured rate. A plan built on one case should be cheap,
and should not claim more than it can show.

## 2. What the code already does, and why it still failed

`HunkIndex.containsSnippet` (`src/ingest/hunk-index.ts`) already accepts a multi-line snippet: it
splits on `\n` and matches consecutive lines of one hunk. What it cannot match is a snippet whose
line breaks were **replaced** - by a space, or by nothing: the join above is
``query(`UPDATE``, with no space where line 11 ends and line 12 begins, and single spaces
elsewhere. `normalizeSnippet` collapses runs of spaces and tabs within a line, but a line break is
not one of them.

`HOW_TO_CITE` in `src/agents/prompts/reviewer.ts` tells the model each evidence string is "a
single line copied exactly from the diff". The model broke that rule; the question is whether the
pipeline should forgive it, correct it, or prevent it.

## 3. Options

**A. Treat a line break as whitespace in the grounding check. Recommended.** When a snippet
matches no single line, try windows of consecutive lines within one hunk - at most five - compared
with all whitespace removed from both sides, and accept only a match that starts in the window's
first line and ends in its last, so it genuinely spans. Deterministic, free, no model call, and
principle 5 holds: every non-whitespace character must still be in the diff, in order, so a
paraphrase or an invented line still fails. The cost is that `evidence` may hold a string that is
not one line, which nothing downstream displays today; Milestone 4's pull-request comment would
be the first reader, and can render it as a block.

**B. Send the grounding failure back to the Reviewer as a repair.** `runAgent` already takes a
`check` whose problems go back to the model as "fix exactly these problems", and the Reviewer
passes none. Wiring `containsSnippet` in there teaches the model inside the run and would also
catch paraphrase. But `runAgent` **throws** when retries run out (`src/harness/loop.ts`), so as it
stands one unquotable finding would fail the whole review stage, where today it only drops that
finding - the opposite of what ADR-024's hand-over principle wants. B needs a harness change
first: a repairable check that, when retries are spent, returns the answer rather than failing.
It also costs a model call per repair, 60 to 100 seconds on qwen3:30b.

**C. Tell the model how to quote a multi-line statement.** One sentence in `HOW_TO_CITE`: for a
statement that spans lines, quote the one line that shows the problem. Cheapest to write, but
every prompt change is a cold re-run, and it is the kind of tuning ADR-044 warned about while the
set is all synthetic.

A and C are compatible. B is the most thorough and the most expensive, and is worth revisiting if
real samples show citation errors other than joined lines.

## 4. Scope if A is approved

- `src/ingest/hunk-index.ts`: the spanning match inside `containsSnippet`, after the existing
  single-line and explicit-multi-line attempts, so nothing that matches today changes.
- Tests in `test/ingest/`: the sample-05 snippet matches; a join with a space and a join with
  nothing both match; a snippet spanning two hunks does not; a window over five lines does not;
  a paraphrase that shares most characters does not; a snippet that matches a single line is
  unaffected.
- No contract change: `evidence` is already an array of strings with no line constraint.
- ADR-045, stating that a line break is whitespace for grounding, and why principle 5 survives it.

## 5. What to check

- `pnpm verify`. The golden-set test that every expected finding survives Verify must still pass
  unchanged.
- Re-score `runs/eval-categories` offline - the reviews are on disk, so no model is needed. The
  expectation is that sample-05's replay finding is kept and recall moves from 5/10 to 6/10. If it
  does not move, the fix did not reach the case it was for.
- Nothing should get **more** permissive in a way the Verifier cannot see: the check stays a check
  of characters present in the diff, and the eval's `dropped` column is where a regression in
  either direction would show.
