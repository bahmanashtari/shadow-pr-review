# Plan: Milestone 1, step 4 (Reviewer agent)

Status: draft, awaiting approval. Read CLAUDE.md, docs/ROADMAP.md, docs/REVIEW_RUBRIC.md,
docs/ARCHITECTURE.md (section "2. Reviewer agent") and docs/DECISIONS.md (ADR-006, ADR-015,
ADR-016, ADR-018, ADR-019, ADR-020) first.

This is the first stage that uses the harness from step 3. It turns `ingest.json` plus the
diff into `review.raw.json`: findings with no `verification` block, which step 5 then checks
and cuts down to `review.json`.

Everything here is shaped by the model trial behind ADR-018 and ADR-019. Those measurements
are the reason three decisions below are not negotiable defaults but tested requirements.

## 1. Scope

In: the Reviewer prompt, the diff rendering, the four read-only tools, the stage that writes
`review.raw.json`, and `spr run --until review` / `spr stage review`.

Out: the Verifier and `review.json` (step 5), the Narrator (step 6), `spr eval` (step 7),
the Verifier *agent* (Milestone 3).

## 2. Prompt (`src/agents/prompts/reviewer.ts`)

The system prompt is assembled in code from files in the repository, never from diff content
(ADR-006, and the injection boundary the loop already enforces):

1. A short role line.
2. The whole of `docs/REVIEW_RUBRIC.md`, read at runtime.
3. An "How to answer" section holding the rules the trial showed are load-bearing.

The third part must state, because every model got these wrong without it:

- How to read the rendered diff, with a worked example of one numbered line.
- That `line_start` and `line_end` must be numbers visible at the start of a line.
- That every finding needs at least one evidence string, each a single line copied exactly,
  with the line number and marker removed, and that a finding whose evidence is not found
  verbatim is discarded. `evidence` is required by the schema now (ADR-019), so a model that
  will not quote cannot report.

The prompt is a pure function of the rubric text, so a rubric change is a prompt change and
`spr eval` must be re-run (ADR-006). A unit test pins that the rubric text appears verbatim.

**Open question A:** the trial found that adding a paragraph of category guidance dropped
recall on `sample-01` from three findings to one. Category accuracy and recall appear to
trade against each other at this model size. I propose shipping *without* category guidance
(favouring recall, since step 5 drops what it cannot verify and a wrong category is cosmetic
next to a missed bug), and letting step 7 settle it with numbers.

## 3. Diff rendering (`src/agents/diff-view.ts`)

A pure function from `ingest.json` to the text the model sees. Given a raw patch, every model
in the trial guessed line numbers badly; given this rendering, every range they produced
passed `HunkIndex.hasRange`.

```
--- file: services/order-service/.../place-order.handler.ts (added) risk 5 ---
@@ hunk: new lines 1..31 @@
   1 +import { CommandHandler } from '@nestjs/cqrs';
  19 +    await this.dataSource.transaction(async (manager) => {
```

- New-side number, then the `+`/`-`/space marker, then the text. Deleted lines show the old
  number in the same column, which `containsSnippet` already tolerates (ADR-020).
- Files in `ingest.json` order; the header carries status and risk score.
- Skipped files are listed once at the end with their reason, so the model knows what it
  cannot see and the intro can say so.

## 4. Tools (`src/agents/tools/`)

Registered through the step 3 `ToolRegistry`, read-only, with the caps CLAUDE.md requires.

| Tool | Input | Returns |
|---|---|---|
| `list_changed_files` | none | path, status, risk, additions/deletions per kept file |
| `get_diff_hunk` | `file` | that file's rendered hunks, same format as section 3 |
| `read_file` | `path`, `start`, `end` | head-revision lines, size-capped |
| `grep_repo` | `pattern`, optional `glob` | matching `path:line: text`, result-capped |

`read_file` and `grep_repo` need a repository. When there is none (a `--diff` run outside a
checkout), they are not registered at all and the prompt says so, rather than being offered
and always failing. `grep_repo` uses `git grep` through `lib/exec.ts` with a fixed argument
list and no shell, and both tools refuse paths that escape the repository root.

**Open question B:** with a 2 KB diff the whole thing fits in the prompt, and the trial ran
with no tools at all and still found the main bugs. Tools matter for big diffs and for
checking whether a repository port already exists. I propose registering them but measuring
in step 7 whether they earn their tool-call budget.

## 5. Stage (`src/agents/reviewer.ts`)

`runReview({ ingest, diffView, provider, config, budget, tracer, cache, repoRoot? })`:

1. Build the system prompt and the user message (the rendered diff).
2. `runAgent` with `schemas/review.schema.json` as the output schema.
3. Code fills in what the model must not choose: finding ids `F01..`, `source` copied from
   `ingest.json`, and `stats.files_reviewed` / `stats.files_skipped`.
4. Validate with `assertContract("review", ...)` and `checkReview`, then write
   `review.raw.json` (2-space JSON, trailing newline).

A budget stop is not an error: whatever findings are valid are written, and the stage says so.

## 6. CLI

- `spr run` continues past ingest into review, then stops at step 5 with the same
  `stopped after review: verify is not implemented yet (Milestone 1, step 5)` shape.
- `spr run --until review` exits 0.
- `spr stage review --run <dir>` re-reads `ingest.json` and `diff.raw.patch` and rewrites
  `review.raw.json`, which is free on a cache hit (ADR-017).
- `spr validate` already understands `review.raw.json`.

## 7. Tests

No network: every test uses `FakeLlmProvider`.

- Prompt: contains the rubric verbatim, contains the evidence and line-number rules, and
  contains no diff content.
- Rendering: line numbers match `HunkIndex`, deleted and context lines are marked correctly,
  a rename and a skipped file render as expected, and the output is deterministic.
- Tools: each returns what it should; `read_file` refuses `../` escapes; caps truncate;
  `read_file` and `grep_repo` are absent when there is no repository.
- Stage: ids are assigned `F01..`, `source` is copied from `ingest.json`, output passes the
  schema and `checkReview`; a scripted invalid answer is repaired; a budget stop writes a
  valid file rather than failing.
- Golden: for each sample, a fake provider replaying `review.expected.json` produces a
  `review.raw.json` whose every range and evidence string passes `hasRange` and
  `containsSnippet`. This is the regression test that the contract and the index agree.
- One end-to-end test through the CLI with the fake provider.

A manual smoke run against local Ollama, pasted into the report, is not part of `pnpm test`.

## 8. Open questions

A. Category guidance in the prompt: recall or category accuracy (section 2).
B. Whether the tools earn their budget on small diffs (section 4).
C. The trial showed both models missing `application-depends-on-orm`, a layer violation a
   `dependency-cruiser` rule would catch every time. I think the right long-term answer is
   deterministic checks feeding the Reviewer as findings it must consider, but that is a new
   dependency and a new stage boundary, so I would rather propose it as a Milestone 3 item
   than smuggle it into step 4.

## 9. Finish

1. `pnpm verify`, `pnpm format:check` and `pnpm build` pass.
2. Smoke run on a golden sample against local Ollama, output in the report.
3. Commit as "Milestone 1 step 4: reviewer agent", push, check CI.
4. Set step 4 to done and step 5 to next in docs/ROADMAP.md.
5. Report what changed from this plan and why. Do not start step 5.
