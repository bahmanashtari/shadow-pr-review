# Plan: Milestone 3, step 1 (the Verifier agent)

Status: proposed. Read CLAUDE.md, docs/ROADMAP.md, ARCHITECTURE.md section 3, and ADR-023,
ADR-025 and ADR-026 first. The short version of what follows: the agent itself is
straightforward and the contract already fits it, but **nothing currently in this repository can
tell whether it helped or hurt**, and section 3 is about fixing that before writing it.

## 1. What it does

ARCHITECTURE.md already specifies it, as the second layer of a stage whose first layer is built:

> For each surviving finding, sees only the relevant hunk(s) and the claim, and answers keep /
> downgrade / drop with a note. Default: a small model; optionally a larger one for high and
> critical findings only (cost flag). `style_only` is its reason to give, not the deterministic
> layer's.

## 2. The contract already fits, so this is additive

Worth stating early, because it makes the step smaller than it looks. Nothing in `schemas/`
needs to change for the agent itself:

- `Verification` is `{ status: "verified" | "downgraded", original_severity?, note? }` - the
  keep and downgrade verdicts, with room to say what it was before and why.
- `DroppedFinding.reason` already carries `claim_not_supported`, `out_of_scope` and
  `style_only` - the three judgement reasons, alongside the mechanical ones the first layer
  uses.
- `runVerify` already writes `verification: finding.verification ?? { status: "verified" }`,
  with a comment saying a verdict from the Milestone 3 agent is left alone. Re-running the
  deterministic layer never erases one.

So the agent slots in after `screenFindings` and before `assertContract`, and every downstream
stage keeps reading the same file.

## 3. The problem: the step cannot currently be judged

ADR-025 makes it a rule that a change to what a model is asked to do is argued with `spr eval`.
This step cannot obey that rule today, for two separate reasons.

**Precision and recall are already 1.000.** ADR-026 measured `qwen3:30b` at 1.000/1.000 on all
three samples and concluded the golden set "has run out of discrimination". For a component
whose only powers are keep, downgrade and drop, that ceiling has a sharp consequence: **the best
outcome available on the current set is "no change", and every other outcome is a regression.**
Drop a true positive and precision falls; drop a `must_find` and recall falls. There is no
measurable win to aim at.

**And the one thing it should fix is invisible to the scorer.** The Verifier's real job is
calibration - the weak spot ADR-015, ADR-018 and ADR-026 all name. But over-rating costs nothing
in `spr eval`, by construction:

- `found()` requires `SEVERITY_RANK[finding] <= SEVERITY_RANK[label.min_severity]`, which is
  "at least as serious as demanded". Rating a `low` issue `critical` passes.
- `locates()`, which is all an `acceptable` label gets, ignores severity entirely.
- `AcceptableLabel` has no severity field at all - not `min_severity`, not anything.

ADR-025 chose this deliberately and said why: it keeps *under*-rating visible as a recall gap
instead of hiding it in precision. That reasoning is sound and the asymmetry it left is the gap
this step falls into.

**The evidence, measured rather than argued.** Comparing `review.expected.json` against what the
default model produced in the Milestone 2 step 6 runs:

| Sample | expected | actual | scored |
|---|---|---|---|
| order-outbox | high, medium | high, medium | 1.000 / 1.000 |
| inventory-consumer | high, high, medium, low | high, high, low | 1.000 / 1.000 |
| email-value-object | **low, privacy** | **critical, security** | **1.000 / 1.000** |

One calibration error in the whole set, and it is a three-level over-rating on the sample whose
`notes` say it exists to check restraint. The scorer gives it full marks.

**It reaches the viewer, too.** ADR-034 watched that sample's video: the narration says "a
critical security issue" twice and the outro card reads "1 issue to fix - 1 critical". The one
video of the three whose voice and card agreed with each other is the one furthest from the
ground truth - they agree because both read the same over-rated field.

## 4. Decisions to take

**Q1. Does this step add a calibration axis to `spr eval` first? Recommendation: yes, as its own
commit, before the agent.**

Otherwise the step ships a component whose entire purpose is unmeasurable, which is the failure
ADR-034 was about in a different guise: a check whose result cannot disagree with it.

The shape, following what ADR-025 gave restraint and what roadmap step 7 wants for redundancy -
its own axis, reported beside precision and recall rather than folded into them:

- `RequiredLabel` gains an optional `max_severity`, the mirror of `min_severity`: together they
  are the band a correctly calibrated finding sits in. `AcceptableLabel` gains both, optional.
- A `calibration` figure per sample: of the kept findings that match a label with a band, how
  many sit inside it, with the out-of-band ones named and their direction given.
- Labels with no band are not scored, so the axis starts empty and fills in as the golden set
  grows - which is how the set gets to say more without every label being rewritten at once.

This is a contract change, so schema, generated types, golden fixtures and an ADR move together
(CLAUDE.md). It is small: one optional field on two label types, one pure scoring function, one
report column.

The alternative is folding it into roadmap step 7, which is already an eval-scoring change of
the same shape, and waiting. That is tidier and leaves this step blocked behind two others.

**Q2. Is step 4 - expanding the golden set - a hard blocker? Recommendation: no, but the claim
this step is allowed to make shrinks to fit.**

With the axis, the current set contains exactly one calibration case. One case can demonstrate
that the mechanism works; it cannot establish a rate. So the finishing claim must be *"it
corrects the one known error and changes nothing else"* - and the "changes nothing else" half is
the one that matters, because it is what a regression would break. A step that says "calibration
improved" on a sample of one would be the same mistake ADR-026 caught in a table that said
"tied, take the fast one".

**Q3. Which model? Recommendation: the configured default, and drop "small" from the
specification.**

ARCHITECTURE says "a small model", and ADR-026 falsified the assumption underneath that phrase
on this hardware: `qwen3:4b` was the *slowest* model measured, 731.7 seconds against the 30B
default's 397.7, because a dense 4B runs more active parameters per token than a 30B
mixture-of-experts. Reaching for the small model to save time does the opposite here.

Recommendation: use the configured `llm.model` by default, add `verify.model` for anyone who
wants to point this stage elsewhere, and **defer the larger-model-for-high-and-critical cost
flag** until there is a hosted-model story worth paying for. It is a config surface and a
branch, on a code path nobody currently has a reason to take, and ARCHITECTURE's sentence can be
corrected in the same commit.

**Q4. One call per finding, or one call for the lot? Recommendation: one per finding.**

The isolation is the mechanism, not an implementation detail - the point of ARCHITECTURE's
"sees only the relevant hunk(s) and the claim" is that the agent cannot be swayed by the
Reviewer's confidence or by the other findings' framing. Per-finding also caches per finding
(ADR-017), so re-running after an edit to one finding is free for the rest, and a budget stop
keeps every verdict already reached. The cost is up to `review.maxFindings` (10) calls, which is
what the budgets in `config/default.json` exist to bound.

**Q5. What happens when the agent cannot run? Recommendation: the deterministic layer's result
stands, and the stage does not fail.**

`SPR_LLM_PROVIDER=fake`, no Ollama, a budget stop or a model that will not produce valid JSON
after its retries all land in the same place: the findings that were judged carry their verdict,
the rest keep `verification.status = "verified"` from the first layer, and `review.json` is
written either way. The precedent is the Reviewer's, where a budget stop "is not an error"
because the analyzer findings alone still make a valid review. Verify is currently the one stage
that runs offline and instantly, and an optional second layer should not take that away - the
CLI line should say how many findings were judged, so a run with none is visible rather than
silent.

## 5. Files

- `src/agents/verifier.ts`: the agent - prompt, per-finding loop, verdict validation.
- `src/agents/prompts/verifier.ts`: the system prompt, built in code the way the Reviewer's is
  from `docs/REVIEW_RUBRIC.md` - the severity anchor is the part that matters here.
- `src/verify/verify.ts`: `runVerify` gains an optional agent pass between `screenFindings` and
  `assertContract`; the deterministic path stays exactly as it is when there is no agent.
- `src/cli.ts`: `spr stage verify` gains the model (it is currently offline and takes no tracer).
- `schemas/labels.schema.json` + `golden/*/labels.json` + generated types, for Q1's band.
- `src/eval/score.ts`, `src/eval/report.ts`: the calibration axis.

## 6. Tests

- The verdict parser: keep, downgrade with `original_severity` and note, drop with a reason,
  and every malformed shape a model can return.
- `runVerify` with a fake agent: a downgrade rewrites severity and records the original, a drop
  moves the finding into `dropped` with the agent's reason, a keep is untouched.
- Idempotence: running the stage twice does not re-judge or erase a verdict, which the existing
  `verification ?? ` line already promises and nothing currently tests.
- No agent at all: byte-identical output to today's, which is the regression that matters.
- The calibration scorer: inside the band, above it, below it, and no band at all.

## 7. Documentation

- `docs/ARCHITECTURE.md`: section 3 layer 2 loses "a small model" (Q3) and gains what the stage
  does when the agent cannot run (Q5).
- `docs/DECISIONS.md`: an ADR for the calibration axis, and one for the agent - or one covering
  both, if the argument reads as a single thread.
- `docs/ROADMAP.md`: step 1 done; step 7's entry should note that the calibration axis is a
  worked example of the shape it wants for redundancy.
- `CLAUDE.md`: `spr stage verify` is no longer "no model, offline" unconditionally.

## 8. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. `spr eval` before and after, on the same models, with the calibration column - the "changes
   nothing else" half of Q2's claim is what this is checking.
3. The one known case: `sample-03-email-value-object` should come out `low` or `medium` rather
   than `critical`, and the video should stop calling it critical.
4. Commit, push, check CI.
