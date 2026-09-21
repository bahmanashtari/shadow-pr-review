# Plan: Milestone 3, step 3 (budgets, cache, and the cost report)

Status: **done, 21 September 2026**, taken under Bahman's instruction to "continue with whatever
else you can" while the real golden samples are outstanding. A and B built as written; C, the
tuning, is deferred until real samples give real sizes (ADR-050). Read ADR-017 and ADR-021.

## 1. What exists

- `cost.json` per run: summed tokens, model calls, tool calls, and dollars - which read 0 on the
  default local model, and "unknown" when a price is missing.
- Budgets in `config/default.json`: 96,000 input and 20,000 output tokens, 30 tool calls, 12 agent
  steps and 30 minutes - **per agent**, not per run: the Reviewer, the Verifier agent and the
  Narrator each get their own. The output budget is also each call's `max_tokens`.
- The model and audio cache: 25 MB in 264 files after every run this project has made. No pruning
  is needed, and none is proposed.

## 2. What the runs on disk say

Across every `cost.json` under `runs/`, the heaviest single sample used 16,128 output tokens in
total (`qwen3:4b`, sample-02), split review 5,734, verify 7,222, narrate 3,172. The heaviest agent
used about a third of its output budget, on a 43-line diff.

That is headroom today and a warning for later. The Reviewer answers in one call with its thinking
included (ADR-021), so its output grows with the change; a real 300-line pull request could plausibly
use several times what a 43-line sample does, and a call that runs out of tokens truncates its JSON
and fails validation rather than degrading gracefully. **But this is a prediction the synthetic set
cannot test**, and tuning a budget on it would be guessing. Tuning waits for the real samples.

## 3. What to do now

**A. Say where the time and tokens went, by stage. Recommended.** `cost.json` gains a `stages` map -
review, verify, narrate - with input and output tokens, calls, cached calls and seconds for each.
The trace already records all of it per call; this sums it. On a local model, time is the cost
that matters, and "which stage" is the first question when a run is slow.

**B. Warn before a budget bites, in `spr eval`. Recommended.** The eval report prints a line when
any agent on any sample used more than half of a budget, naming the sample, the stage and the
share. On today's set it prints nothing. The day real samples land it is the first place a
budget problem shows, before a run fails on one.

**C. Tune the budgets. Deferred** until real samples give real sizes; B is what will say when.

## 4. What to check

- `pnpm verify`; the new `cost.json` shape is exercised by the CLI tests that already read it.
- `spr eval` from cache on the current set: the headroom line stays silent, and a unit test forces
  it to speak.
