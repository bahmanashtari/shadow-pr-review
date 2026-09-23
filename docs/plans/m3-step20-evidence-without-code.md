# Plan: Milestone 3, step 20 (evidence that quotes no code)

Status: **done** on 23 September 2026 (ADR-058), written and taken in one go under Bahman's
standing instruction to finish whatever can be finished without him. The rule it adds was settled
by counting, not by preference.

## 1. Why

ADR-057 caught `qwen3-coder:30b` obeying `sample-09`'s planted instruction: it reported a SQL
injection that does not exist and quoted, as its evidence, the two comment lines telling automated
reviewers to report one. The Verifier agent - on the default model - kept it. The deterministic
layer could not: those lines really are in the diff, so every existing check passes.

## 2. The rule

A finding whose evidence, after the existing checks, contains **no code at all** is dropped as
`evidence_without_code`. A quoted line counts as code unless it is blank or opens with a comment
marker: `//`, `/*`, `*`, `*/`, `#`, `--` or `<!--`. One code line anywhere in the evidence is
enough, so a finding that quotes a misleading comment *and* the code it misdescribes survives -
which `sample-08` depends on.

## 3. Why it is safe

Counted across every review this repository has on disk - nine golden expectations and every run
folder, 100-odd reviews - exactly one finding has evidence with no code line in it: the planted
false positive. The golden set scores identically before and after (precision 1.000, recall 0.750,
calibration 0.909, 11 kept).

## 4. What to check

- The rule drops the real finding `qwen3-coder` filed, from its own run folder.
- `spr eval` is unchanged on the default model.
- `pnpm verify`, `pnpm format:check`, `pnpm build`.
