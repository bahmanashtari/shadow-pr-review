# Plan: Milestone 1, step 4 (Analyzers, then the Reviewer agent)

Status: done. Implemented in "Milestone 1 step 4: analyzers and the Reviewer agent". Read CLAUDE.md, docs/ROADMAP.md, docs/REVIEW_RUBRIC.md,
docs/ARCHITECTURE.md (section "2. Reviewer agent") and docs/DECISIONS.md (ADR-002, ADR-006,
ADR-015, ADR-016, ADR-018, ADR-019, ADR-020, ADR-021) first.

This step turns `ingest.json` plus the diff into `review.raw.json`. It has two halves,
in this order:

1. **Analyzers** - deterministic findings from the diff text alone. No model, no new
   dependency, no checkout.
2. **Reviewer agent** - the judgement calls, told what the analyzers already found.

## 1. Why the analyzers come first

ADR-002 says agents are for judgement and everything else is plain code. Until now the
Reviewer was being asked to do both. The measurements say that was costing real findings:

- Both models, in every run, missed `application-depends-on-orm` on `sample-01`. It is an
  import statement. A prototype caught it deterministically at 100% grounding.
- A prototype over `ingest.json` alone caught 2 of the 4 `must_find` labels across the golden
  set in milliseconds, every one passing `hasRange` and `containsSnippet`, and correctly
  found nothing on `sample-03`, which exists to test restraint.

What stays with the model: whether an event should be in an outbox, whether a consumer is
idempotent, whether an error message leaks PII. Those are judgement and the model is good at
them - thinking on, it found the PII case nothing else did (ADR-021).

**What is deliberately not in scope:** `tsc`, `eslint` with the target repo's config, and
`dependency-cruiser`'s cross-file graph. Those need the reviewed repository's
`node_modules`, its `tsconfig`, and its configuration, and they mean running someone else's
toolchain. A `--diff` run has no checkout at all. They belong in Milestone 4, where a PR run
has one. Everything below reads only the diff text, so it works for every source.

## 2. Analyzers (`src/analyzers/`)

`analyze(ingest): AnalyzerFinding[]` - a pure function, no I/O, no repository.

Rules, each keyed and individually testable:

| Key | Fires on | Severity | Category |
|---|---|---|---|
| `domain-imports-infrastructure` | a `domain/` file importing an ORM, `@nestjs/*`, a broker client, or an `infrastructure/`/`interface/` path | high | ddd-boundaries |
| `application-imports-orm` | an `application/` file importing an ORM package or an `infrastructure/` path | medium | ddd-boundaries |
| `not-null-without-default` | `ADD COLUMN ... NOT NULL` with no `DEFAULT` | high | data-migration |
| `index-without-concurrently` | `CREATE INDEX` with no `CONCURRENTLY` | medium | data-migration |
| `empty-down` | a migration's `down()` with an empty body | low | data-migration |
| `sql-string-interpolation` | `${...}` inside a SQL-looking template literal | critical | security |

Two refinements that keep precision high, because a rule that cries wolf is worse than no
rule:

- `not-null-without-default` does not fire when the same file also creates that table:
  a `NOT NULL` column on a table being created in the same migration is correct.
- `sql-string-interpolation` requires a SQL keyword in the same literal, so an ordinary
  template string is not flagged.

Every rule reads one added line and quotes that line verbatim, so evidence is exact by
construction and `containsSnippet` cannot fail. Findings carry `confidence: 0.95` rather
than 1.0: these are high-precision heuristics, not proofs, and step 5 still checks them.

## 3. Diff rendering (`src/agents/diff-view.ts`)

A pure function from `ingest.json` to the text the model sees. Required, not cosmetic: given
a raw patch every model guessed line numbers badly; given this rendering every range passed
`hasRange` (ADR-018).

```
--- file: services/order-service/.../place-order.handler.ts (added) risk 5 ---
@@ hunk: new lines 1..31 @@
   1 +import { CommandHandler } from '@nestjs/cqrs';
  19 +    await this.dataSource.transaction(async (manager) => {
```

Skipped files are listed once at the end with their reason, so the model knows what it
cannot see.

## 4. Prompt (`src/agents/prompts/reviewer.ts`)

Assembled in code from repository files, never from diff content: a role line, the whole of
`docs/REVIEW_RUBRIC.md` read at runtime, then an "How to answer" section carrying the rules
the trial proved load-bearing - how to read a numbered line, that line numbers must be ones
actually visible, and that every finding needs at least one exactly-copied evidence line.

Two additions from the measurements:

- **Severity must be anchored explicitly.** With thinking on, the model rated a
  `min_severity: high` issue as `medium` (ADR-021), and ADR-015 saw the same. The prompt
  restates the severity table from the rubric in the answer rules.
- **The analyzer findings are listed as already reported**, with an instruction not to
  repeat them and to spend the budget on what they cannot see. This is what makes the split
  pay off rather than just producing duplicates.

No category guidance: the trial showed a category paragraph dropping recall from three
findings to one, and step 5 drops what it cannot verify while a wrong category is cosmetic
next to a missed bug. Step 7 re-tests this.

## 5. Tools (`src/agents/tools/`)

Through the step 3 `ToolRegistry`, read-only, capped.

| Tool | Input | Returns |
|---|---|---|
| `list_changed_files` | none | path, status, risk, additions/deletions per kept file |
| `get_diff_hunk` | `file` | that file's rendered hunks |
| `read_file` | `path`, `start`, `end` | head-revision lines, size-capped |
| `grep_repo` | `pattern`, optional `glob` | `path:line: text`, result-capped |

`read_file` and `grep_repo` need a repository. Without one they are not registered and the
prompt says so, rather than being offered and always failing. Both refuse paths escaping the
repository root; `grep_repo` goes through `lib/exec.ts` with a fixed argument list, no shell.

## 6. Stage (`src/agents/reviewer.ts`)

`runReview({ ingest, provider, config, budget, tracer, cache, repoRoot? })`:

1. Run the analyzers.
2. Build the prompt and the rendered diff; run `runAgent` against `schemas/review.schema.json`.
3. Merge: analyzer findings first, then model findings, dropping a model finding that
   overlaps an analyzer finding on the same file and category.
4. Code assigns what the model must not choose: ids `F01..`, `source` copied from
   `ingest.json`, `stats`. Sort by severity so `checkReview` passes.
5. `assertContract("review", ...)` plus `checkReview`, then write `review.raw.json`.

A budget stop is not an error: the analyzer findings alone still make a valid file, which is
a real improvement - a run that cannot reach the model still produces a review.

## 7. CLI

`spr run` continues into review and stops at step 5 with
`stopped after review: verify is not implemented yet (Milestone 1, step 5)`.
`--until review` exits 0. `spr stage review --run <dir>` rewrites `review.raw.json`, free on
a cache hit.

## 8. Tests

No network; `FakeLlmProvider` throughout.

- Analyzers: each rule fires and, more importantly, each rule's near-miss does not - a
  `NOT NULL` column on a table created in the same migration, a template literal with no SQL,
  a `domain/` file importing another `domain/` file. Every finding's evidence passes
  `containsSnippet` and its line passes `hasRange`, for all three golden samples.
- Rendering: numbers match `HunkIndex`; deterministic.
- Prompt: contains the rubric verbatim and the evidence rules; contains no diff content.
- Tools: each returns what it should; `read_file` refuses `../`; absent without a repository.
- Stage: ids assigned, `source` copied, severity ordering, duplicates dropped, output passes
  the schema and `checkReview`; a budget stop still writes analyzer findings.
- Golden: for every sample, every range and evidence string in the output resolves.

Smoke run against local Ollama, pasted into the report, outside `pnpm test`.

## 9. Finish

1. `pnpm verify`, `pnpm format:check`, `pnpm build`.
2. Smoke run on a golden sample; output in the report.
3. Commit, push, check CI.
4. Step 4 done, step 5 next in docs/ROADMAP.md; ADR for the analyzer split.
5. Report. Do not start step 5.
