# Plan: Milestone 1, step 7 (`spr eval`)

Status: done. Implemented in "Milestone 1 step 7: spr eval" (ADR-025, ADR-026).
All three open questions were decided as recommended: eval.json gets a schema, the
eval runs through narrate, and `--model` is repeatable so one command produces the comparison). Read CLAUDE.md, docs/ROADMAP.md,
`golden/README.md` and docs/DECISIONS.md (ADR-015, ADR-017, ADR-018, ADR-021, ADR-022, ADR-024)
first.

This step closes Milestone 1 by making the pipeline measurable. Until now every judgement about
the Reviewer has been made by reading output. ADR-018 is explicit about the debt: the default
model "remains provisional until step 7 scores all three golden samples with precision and
recall, including `must_not_flag`", and ADR-015 says the same about the model choice generally.
This step is what settles it, and what makes every future prompt change checkable.

## 1. What it does

For each sample in `golden/`, run the real pipeline on `diff.patch` (ingest, review, verify,
and narrate), then score the produced `review.json` and `script.json` against that sample's
`labels.json`. Print a table, write `eval.json`.

Nothing here scores the `*.expected.json` fixtures against themselves - that would measure
nothing. They stay what `golden/README.md` says they are: a target to read, and the input to
the narration comparison in section 4.

## 2. Scoring

`golden/README.md` already states the matching rule, and the labels already carry what it
needs. A `must_find` item is **found** when a kept finding has the same file, an overlapping
line range, a category equal to `category` or listed in `accept_categories`, and severity at
least `min_severity`.

- **Recall** = found `must_find` items / all `must_find` items. There are four across the set
  (two in sample-01, two in sample-02, none in sample-03).
- **Precision** = kept findings that match a `must_find` or an `acceptable` item / all kept
  findings.

**`must_not_flag` needs no matching rule, and that is the point.** Those entries carry only a
`key` and a `description` - no file, no lines, no category - so there is nothing to match on,
and one of them (`missing-tests` in sample-03) is about the *absence* of code and could never
have a line range. The precision rule above already counts any such finding as a false
positive, because it matches neither list. So `must_not_flag` is not arithmetic: it is the
named list of the mistakes this set was built to catch, and the eval reports it as a
diagnostic, listing each false positive next to the `key` whose description it appears to
match, or as `unlabelled` when it matches none.

That keeps the labels as they are. The alternative - adding locations to `must_not_flag` so
they can be matched mechanically - buys nothing the general rule does not already give, and
cannot express the one entry that matters most for restraint.

**Two sample-level facts the averages would hide**, reported per sample:

- `sample-03-email-value-object` has no `must_find` items at all. Its recall is not 0 and not
  1; it is undefined, printed as `-`, and it contributes nothing to the denominator. The
  sample exists to test restraint, so its real score is precision and its false positives.
- A finding dropped by the Verifier is not a false positive - it never reached the viewer -
  but *why* it was dropped is the most useful diagnostic in the run. The eval reports the
  `dropped` reasons per sample alongside the scores, because a model that produces good
  findings with unquotable evidence and a model that produces bad findings both score the
  same on precision and need opposite fixes.

Overall precision and recall are micro-averaged: pool the items across samples rather than
averaging three rates, so a sample with one finding does not weigh as much as one with four.

## 3. Comparing models, which is the point of the step

ADR-015 and ADR-018 both defer the model decision to this step, and four candidates are
installed: `qwen3:30b` (the current default), `qwen3-coder:30b`, `mistral-small3.2` and
`qwen3:4b`. So `spr eval` takes a repeatable `--model`:

```
pnpm spr eval                                        # the configured model
pnpm spr eval --model qwen3:30b --model qwen3:4b     # one row per model, one table
pnpm spr eval --no-cache                             # a cold measurement, ignoring ADR-017
```

One run per model per sample, scored the same way, printed as the comparison table ADR-018
already writes by hand. That table is the deliverable that lets the provisional default in
`config/default.json` be confirmed or replaced, and the result belongs in an ADR either way.

The cache (ADR-017) keys on model, so a comparison never serves one model's answer for
another. But a cached run measures a past model against a present set of labels, so `--no-cache`
exists for the measurement that goes into an ADR, and the eval records `cached: true/false` per
sample so a table can never silently mix the two.

## 4. Narration

The roadmap asks for narration checks, and the honest answer is that the deterministic ones
cannot fail here. `checkScript` runs inside the Narrate stage and the stage fails rather than
writing a script that breaks it (ADR-024), so re-asserting "no markdown, no file names, at most
60 words" against `script.json` would be a test that always passes.

What is worth measuring is what the checks do not constrain:

- steps, words per step, and the estimated duration against `script.expected.json` - a script
  half the expected length is a real signal, and a numeric one.
- whether every kept finding is narrated (guaranteed by `checkScript`, so reported as a fact
  rather than scored) and whether the run reached a script at all: a failed Narrate stage with
  its `script.rejected.json` is a result the eval must record, not an error that aborts it.

Tone against `script.expected.json` is a judgement call and stays a human read, as
`golden/README.md` says. It is not scored, and the eval does not pretend to.

## 5. Files

```
src/eval/score.ts    # pure: labels + review + script -> a sample's scores. No I/O, no model.
src/eval/run.ts      # the command: walk golden/, run the pipeline per sample, aggregate, write
src/eval/report.ts   # pure: scores -> the printed table
```

`src/eval/` rather than `src/agents/` or a script, for the reason ADR-023 put the deterministic
Verifier in `src/verify/`: it calls a model only by running the pipeline, and the scoring itself
is plain code that must be unit-testable without one.

`spr eval` is already registered in `src/cli.ts` and exits 2; it gains `[dir]` (default
`golden`), `--model`, `--out`, `--no-cache` and `--until`.

## 6. Tests

`test/eval/score.test.ts` and `test/eval/report.test.ts`, both without a model or network, plus
a CLI test with `SPR_LLM_PROVIDER=fake`.

- each arm of the match rule fires and misses: right file wrong lines, overlapping lines wrong
  category, an `accept_categories` category counts, severity one step below `min_severity` does
  not, severity above it does.
- a finding matching an `acceptable` item is a true positive but never counts toward recall.
- a sample with no `must_find` items reports recall `-` and is left out of the aggregate
  denominator, and its precision is still computed.
- a false positive is reported against the `must_not_flag` key it matches, and as `unlabelled`
  when it matches none.
- dropped findings never count as false positives, and their reasons are counted per sample.
- micro-averaging: two samples with different finding counts aggregate by item, not by rate.
- **Regression against the fixtures:** scoring each sample's own `review.expected.json` against
  its `labels.json` gives recall 1.0 and precision 1.0. If that ever fails, either a fixture or
  the labels drifted - the same guard the golden test in step 5 gave the Verifier.
- CLI: `spr eval` on a temporary golden folder with the fake provider writes `eval.json` and
  prints a table; a sample whose Narrate stage fails is reported, not fatal.

## 7. Decisions taken

**`eval.json` gets a schema.** `schemas/eval.schema.json`, generated types, and registration in
`contracts/schemas.ts`, so `spr validate eval.json` works like every other artefact on disk.
It is a report rather than a contract between stages, so this is consistency rather than
necessity - but it is cheap, and CLAUDE.md is unambiguous that JSON Schema is the source of
truth for what the tool writes.

**The eval runs through narrate.** Every sample goes ingest, review, verify, narrate. The
roadmap asks for narration checks, and producing a script is the only way to see that a review
is narratable at all: a review whose findings cannot be spoken is a real failure and Milestone 1
should not close without the Narrator having been measured on the golden set. It roughly doubles
the model time per sample, which the cache absorbs on every run after the first.

**`--model` is repeatable.** One invocation produces the whole comparison table, so every row
used the same labels, the same prompt and the same code by construction. Comparing separate runs
would leave room for a table whose rows silently came from different prompts - the exact trap
ADR-018's closing note warns about, where recall on sample-01 moved from three findings to one
because of a prompt paragraph rather than a model.

## 8. Documentation

- `docs/ROADMAP.md`: step 7 done, Milestone 1 complete.
- `docs/ARCHITECTURE.md`: a short section on evaluation.
- `CLAUDE.md`: the `spr eval` commands, and `src/eval/` in the layout.
- `golden/README.md`: fold in the `must_not_flag` and empty-`must_find` rulings from section 2.
- `docs/DECISIONS.md`: ADR-025 for the scoring rules, and **an ADR recording the model
  comparison** - the measurement ADR-015 and ADR-018 have both been waiting for, either
  confirming `qwen3:30b` or replacing it.

## 9. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. Run the real comparison: all four installed models, all three samples, `--no-cache`, and put
   the table in the report and in the ADR.
3. Commit, push, check CI.
4. Report. Milestone 1 is then done; do not start Milestone 2.
