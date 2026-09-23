# Plan: Milestone 3, step 16 (one cold run cannot tell a change from a tip)

Status: **proposed**, written at the end of the session that finished Milestone 4 and Milestone 3
steps 17 and 20. It is the step marked next. Read CLAUDE.md, docs/ROADMAP.md, ADR-025 (what
`spr eval` scores), ADR-047 (the run that started this), ADR-054 and ADR-057 first.

## 1. The problem, in one measured example

The model runs at temperature 0, so a repeated run is identical and the project has been treating
each number as exact. It is not. ADR-047 changed one sentence of an unrelated prompt and recall
moved 0.600 to 0.800; the analyzer move in ADR-049 then moved `sample-02` back. Nothing in the
harness can currently tell "this prompt is better" from "this prompt happened to land well on nine
samples", and two steps now wait on that: **step 19** (the Reviewer asserting what unread code
does, ADR-054) is exactly the kind of one-sentence prompt change that cannot be judged on one cold
run, and any future rubric edit has the same problem.

## 2. What to build

A way to run the golden set several times under *neutral* perturbations and report a **range**
rather than a point. The perturbation must not change what is being asked, only how the asking is
arranged, so that any movement in the score is noise by construction.

Three candidates, cheapest first:

- **Sample order.** The Reviewer sees one diff at a time, so order should not matter at all - but
  `spr eval` reports a total across samples, and a run that fails halfway scores differently.
  Cheap, and probably measures nothing; worth one run to confirm it measures nothing.
- **A small temperature with fixed seeds.** `temperature: 0.2` with three seeds is the standard
  answer and the honest one: it samples the distribution the model actually has. Ollama takes a
  `seed` option, so the runs are reproducible. Needs a `seed` in the provider and the cache key,
  or every seed collides in the cache.
- **Neutral prompt perturbations.** Re-order independent rubric sections, or the findings handed
  to the Verifier. Closest to the thing being tested - a prompt edit - and the most work to keep
  genuinely neutral.

Recommendation: the second, with the first as a sanity check. The third is a later refinement if
the second turns out to under-report the spread a prompt edit sees.

## 3. Shape

- `llm.seed` in the config, and `--seed` (repeatable) on `spr eval`, so one invocation produces
  the whole spread the way `--model` produces the whole comparison.
- The seed joins the cache key (ADR-017), or the second seed's run is served the first's answers.
- `eval.json` gains, per model, the per-seed results and a summary: for each axis, the median and
  the range. `formatReport` prints `recall 0.700 (0.600-0.800, n=3)` rather than `recall 0.700`.
- A claim in an ADR then has to clear the range, not the point, and `docs/ROADMAP.md` step 19 can
  finally be argued about.

## 4. What it costs

A cold pass over nine samples is about 14 minutes on this machine's default model; three seeds is
roughly 45 minutes of local compute per measurement, and nothing in CI. That is the price of a
number that means something, and it is paid only when a prompt or model change is being argued
for - `spr eval` with no `--seed` stays one run.

## 5. Open questions for Bahman

**Q1. Is a temperature above 0 acceptable for a measurement, given the pipeline runs at 0?**
It measures the model's spread, not the pipeline's, which is the point - but it is a real change
in what the number describes, and worth his nod. Recommendation: yes, for `spr eval` only, with
the production default untouched.

**Q2. Three seeds or five?** Three is enough to see a range and costs 45 minutes; five is steadier
and costs 75. Recommendation: three, with `--seed` repeatable so anybody can ask for more.

## 6. What to check

- The same seed twice gives identical scores (the cache proves it, and so should a cold run).
- Different seeds give a range on at least one axis; if they do not, say so - that is a finding
  about the golden set, not a failure.
- The default `spr eval` is unchanged in cost and output shape when no `--seed` is passed.
- `pnpm verify`, `pnpm format:check`, `pnpm build`.
