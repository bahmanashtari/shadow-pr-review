# Plan: Milestone 3, step 15 (findings on unchanged lines)

Status: **done, approved by Bahman on 21 September 2026 as recommended below.** Built as written.
The offline check dropped exactly the unchanged-import finding; the cold run dropped nothing on
the default model and read recall 0.800, which ADR-047 declines to credit to this step. Read
ADR-045 and ADR-047.

## 1. What happened

The rubric's first scope rule is "review only what the change introduces or makes worse;
unchanged code is context, not a target". Nothing enforces it. Verify checks that a finding's
lines are in the diff, and the unchanged lines around a change are in the diff, as context.

It went unnoticed while every golden diff added whole files, because an added file has no
context lines. `sample-06-customer-search` is the first diff that modifies files, and on it
`qwen3:4b` reported *"Controller depends on infrastructure implementation"* on line 3, an import
the pull request did not touch. The Verifier agent kept it (ADR-045). It may be a fair remark
about the codebase; it is not something this pull request did, and a video about the pull request
is the wrong place for it.

## 2. The decision

**A finding whose lines include no added line (on the new side) or removed line (on the old side)
is dropped as `out_of_scope`.** The reason already exists in the review contract, for a finding in
a file the change never touched; a finding on lines the change never touched is the same mistake
one level down.

**The worry, and why it does not stop the rule.** A change can break code it did not touch: a
function starts returning `null`, and an unchanged caller shown in context now crashes. But the
cause of that regression is always a changed line - the new `return null` - so a well-placed
finding points there and names the broken caller in its rationale. The rule loses nothing such a
finding needs, provided the Reviewer is told to anchor that way. So the rubric's scope rules gain
exactly that instruction, and the check and the instruction land together.

## 3. Scope

- `src/ingest/hunk-index.ts`: remember which lines each file's hunks added and removed, and a
  `touchesChange(path, side, start, end)` question beside `hasRange`.
- `src/verify/grounding.ts`: after the range check and before the evidence check, drop a finding
  that touches no change. The order matters: a finding outside the change is out of scope whatever
  it quotes.
- `docs/REVIEW_RUBRIC.md`: one scope rule - point a "this change breaks that code" finding at the
  added or removed line that causes it, and name the affected code in the rationale.
- The deterministic analyzers scan added lines only, so none of their findings can be affected.
- No schema change: `out_of_scope` is already a drop reason.

## 4. What to check

- `pnpm verify`. Every golden expected finding must still survive Verify; all of them already sit
  on added lines.
- `spr stage verify` on a copy of `qwen3:4b`'s sample-06 run from ADR-045, offline: the unchanged
  import finding is dropped as `out_of_scope`, and nothing else changes.
- `spr eval` with the default model, cold because the rubric is part of the prompt. Recall must not
  fall below 0.600, and any new `out_of_scope` drop is read, not assumed right.
