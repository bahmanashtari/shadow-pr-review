# Plan: Milestone 3, step 17 (a model per stage)

Status: **built** on 23 September 2026 (ADR-057), written and taken in one go under Bahman's
standing instruction to carry on with whatever can be finished without him. The decision it
records is a measurement, not a preference, so it needed no question.

## 1. Why

ADR-045 measured `qwen3-coder:30b` at five times the default's review speed, with two false
positives and, fatally, narration it could not shrink under the 60-word cap - so it failed
Narrate on two of five samples. The conclusion was "as the Reviewer alone it may still be, and
that is a configuration this project does not have". This step is that configuration.

`llm.verifierModel` already existed in the config schema and **nothing read it**: a leftover of
the small-verifier idea ADR-037 dropped. Config surface with no behaviour is worse than none, so
it goes.

## 2. What was built

- `llm.models`: optional per-stage overrides, `review`, `verify` and `narrate`. A stage with no
  entry uses `llm.model`, so one model everywhere stays the default and nothing changes for
  anyone who does not opt in.
- `SPR_LLM_MODEL_REVIEW`, `_VERIFY`, `_NARRATE` in the environment table; `SPR_LLM_VERIFIER_MODEL`
  and `llm.verifierModel` removed.
- `modelFor(config, stage)` and `createProvider(config, secrets, stage)`; the CLI and `spr eval`
  build one provider per stage.
- `spr eval` with no `--model` scores the configuration as it stands, per-stage models included,
  and labels the row by stage when they differ. Each `--model` still means one model for the
  whole pipeline, because a row of a comparison table has to mean one thing.

## 3. What to measure

The golden set, twice: the default everywhere, then `review` on `qwen3-coder:30b` with verify and
narrate on the default. Precision, recall, calibration, false positives, and wall clock. The
question is whether the fast Reviewer keeps the default's findings when it is not also asked to
narrate them.

## 4. What to check

- `pnpm verify`, `pnpm format:check`, `pnpm build`.
- The comparison above, recorded in the ADR with its numbers.
- CLAUDE.md's configuration section names the new variables.
