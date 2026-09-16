# Plan: Milestone 1, step 2 (Ingest)

Status: approved. Read CLAUDE.md, docs/ROADMAP.md, docs/ARCHITECTURE.md (section
"1. Ingest") and docs/DECISIONS.md (ADR-013 and ADR-014) first.

`schemas/ingest.schema.json` is the contract for this step and is already in the repo.
Do not change it, or the design docs, without asking: if the implementation needs to
differ from them, stop and explain why. If you see a problem with this plan, raise it
before writing code; otherwise implement it.

## 1. Contract wiring

- Add `"ingest"` to `CONTRACT_NAMES` in `src/contracts/schemas.ts`; `contractFromFileName`
  maps `ingest.json` and `ingest.expected.json` to it. Run `pnpm gen:types` and commit the
  generated `src/contracts/generated/ingest.ts`. `validate.ts` gets the new type in
  `ContractTypes`.
- Test: `$defs.Source` in `ingest.schema.json` deep-equals `$defs.Source` in
  `review.schema.json`.
- `checkIngest(ingest)` in `src/contracts/checks.ts` (with tests):
  - file paths are unique across `files` and `skipped`;
  - `stats` matches the arrays (counts, and additions/deletions summed over kept files);
  - each file's additions/deletions equal its add/del line counts;
  - per hunk: context + del lines == `old_lines`, context + add lines == `new_lines`;
    old numbers run consecutively from `old_start` and new numbers from `new_start`
    (skip a side whose count is 0); `add` lines have `old: null`, `del` lines `new: null`,
    context lines have both;
  - `no_newline_at_eof` appears at most once per side per file, on the last line of that side.

## 2. Dependencies

`pnpm add execa picomatch` and `pnpm add -D @types/picomatch`. Keep the pnpm 12 build
approval list unchanged unless install asks for a new approval; if it does, tell me which
package and why before approving.

## 3. Library helpers (`src/lib/`)

- `exec.ts`: `run(command, args, { cwd, timeoutMs = 30_000, env? })` over execa, returns
  stdout. On failure throw an Error whose message includes the command and the last
  20 lines of stderr. No shell.
- `hash.ts`: `sha256(data: string | Uint8Array): string` (lowercase hex).
- `run-folder.ts`: `createRunFolder({ runsDir, id, out?, force?, now? })`.
  Default name `YYYYMMDDTHHMMSSZ-<id>` (UTC) under `runsDir`. If `out` exists and is not
  empty, throw a `StageError("ingest", ...)` unless `force` is true. Return the absolute path.

## 4. Diff parser (`src/ingest/parse-diff.ts`)

`parseDiff(text: string): ParsedFile[]` for git-format unified diffs. No dependency.

- Ignore any preamble before the first file header (for example `git format-patch` mail headers).
- File headers: `diff --git`, `new file mode`, `deleted file mode`, `old mode` / `new mode`,
  `similarity index`, `dissimilarity index`, `rename from/to`, `copy from/to`, `index`,
  `--- a/...` / `+++ b/...` / `/dev/null`.
- Also accept plain unified diffs that have only `---` / `+++` headers (strip `a/` `b/`
  prefixes when present).
- Quoted paths: git C-style quoting (`"a/dir/file with \"quotes\".ts"`, octal escapes such
  as `\303\251` decoded as UTF-8 bytes, `\t`, `\n`, `\\`).
- Binary: `Binary files ... differ` and `GIT binary patch` mark the file as binary (no hunks).
- Hunks: `^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$`, a missing count means 1.
  Lines: `+`, `-`, ` `, and `\ No newline at end of file` (sets `no_newline_at_eof` on the
  previous line). A completely empty line inside a hunk counts as an empty context line.
  Strip one trailing `\r` from line text.
- Stop reading a hunk exactly when both counts are satisfied; anything else that does not
  start a new file header is an error. Malformed input (bad counts, unknown line prefix inside
  a hunk, hunk before any file header) throws `StageError("ingest", "<file> hunk <n>: <problem>")`.
- Statuses: added, modified, deleted, renamed, copied (mode-only change is `modified` with
  no hunks). `path` is the new path, or the old path for deletions; `old_path` only for
  renamed/copied.
- Keep each file's raw text block exactly as in the input so `diff.patch` can be rebuilt by
  concatenating the kept blocks. Rebuilding with every file kept must reproduce the input
  (normalized to end with a single `\n`).

## 5. Filter (`src/ingest/filter.ts`)

`classify(file, config.ingest): SkipReason | null`, applied in this order:
1. binary -> `binary`
2. raw block bytes > `maxFileBytes` -> `too_large`
3. path matches any `ignoreGlobs` (picomatch, `{ dot: true }`; match the new path, or the
   old path for deletions) -> refine the reason:
   `lockfile` if the basename is one of package-lock.json, npm-shrinkwrap.json,
   pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb;
   `vendored` if a path segment is `vendor`, `third_party` or `node_modules`;
   `generated` if a segment is `generated`, `__generated__`, `dist`, `build` or `coverage`,
   or the name matches `*.generated.*`, `*.gen.ts`, `*.min.js`, `*.snap`, `*.pb.ts`;
   otherwise `ignored_by_config`.
4. otherwise keep.

Config fully controls step 3: a file that matches no glob is kept even if it looks generated.

## 6. Risk score (`src/ingest/risk.ts`)

`riskScore(path): number`, the sum of every matching rule. Export the rule table and test it.
Match case-insensitively on the full path.

| Points | Rule |
|---|---|
| +5 | a `migration` or `migrations` segment, or a `.sql` file |
| +4 | a `domain` segment |
| +4 | basename contains consumer, producer, publisher, subscriber, handler, listener, outbox, inbox, saga, process-manager, or event |
| +4 | path contains auth, guard, permission, policy, security, crypto, or token |
| +2 | an `infrastructure` segment, `.github/workflows/`, `Dockerfile`, `docker-compose`, `.env`, or `*.config.*` |
| +1 | a `.ts` file under a `src` segment |
| -2 | `.spec.ts`, `.test.ts`, a `test` / `tests` / `__tests__` segment |
| -3 | a `.md` file or a `docs` segment |

Total budget: if the kept raw blocks together exceed `maxDiffBytes`, rank kept files by
risk (descending), then path (ascending), and keep greedily while they fit; a file that does
not fit is skipped as `too_large` and the loop continues with the next one. Set
`diff.truncated` to true when this drops anything. Output order in `files` and `skipped`
is always diff order.

## 7. Sources (`src/ingest/sources.ts`)

- `fromDiffFile(path, { title? })`: reads the file; `source.type = "local_diff"`, other
  source fields null except `title`. Run id: first 7 characters of the raw diff's sha256.
- `fromGitRange(range, { cwd, title? })`:
  - Accept only `A..B` or `A...B` with no whitespace; reject anything starting with `-`.
  - Resolve both ends with `git rev-parse --verify --end-of-options <rev>^{commit}`.
    For `A...B`, `base_sha` is `git merge-base A B`.
  - Diff command, immune to user git config:
    `git -c core.quotePath=false -c color.ui=false -c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.relative=false diff --no-color --no-ext-diff --no-textconv --find-renames --unified=3 --src-prefix=a/ --dst-prefix=b/ --end-of-options <range>`
  - `source.type = "push"`; `head_sha`, `base_sha` full shas; `ref` = current branch
    (`git symbolic-ref --short -q HEAD`) only when B resolves to the same commit as HEAD,
    else null; `repo` = `owner/name` parsed from `git remote get-url origin` when it is a
    GitHub URL (https or ssh), else null; `title` = the option, else the subject of B.
  - Run id: first 7 characters of `head_sha`.
- `--pr` stays unimplemented (Milestone 4).

## 8. Stage (`src/ingest/ingest.ts`) and index (`src/ingest/hunk-index.ts`)

- `buildIngest({ rawDiff, source, config }): { ingest: IngestResult; keptPatch: string }` is
  pure. It validates its own output with `assertContract("ingest", ...)` and `checkIngest`.
- `writeIngest(runDir, rawDiff, result)` writes `diff.raw.patch`, `diff.patch` and
  `ingest.json` (2-space JSON, trailing newline). Same input and config give identical bytes.
- `HunkIndex.fromIngest(ingest)` with:
  - `hasFile(path)`, `file(path)`, `files()`;
  - `hasRange(path, side, start, end)`: true only if every line in the range exists on that
    side in the diff (`add`/`context` for new, `del`/`context` for old);
  - `lineText(path, side, line)`;
  - `containsSnippet(path, snippet)`: whitespace-normalized (trim, collapse runs of spaces
    and tabs) match within one diff line of that file; a snippet containing newlines must
    match consecutive lines of one hunk.

## 9. CLI

- `spr run`: exactly one of `--diff` or `--git` (`--pr` exits 2 with a Milestone 4 message).
  Options: `--title`, `--out`, `--force`, `--until <stage>` (validated against the stage
  list). It runs ingest, prints the run folder and a one-line summary such as
  `3 files: 2 kept (+45 -3), 1 skipped (1 lockfile)`, then continues to the next stage.
  The first stage that is not built stops the run with exit code 2:
  `stopped after ingest: review is not implemented yet (Milestone 1, step 4). Run folder: <path>`.
  With `--until ingest` it exits 0 after ingest.
- `spr stage ingest --run <dir>`: re-runs filtering on `<dir>/diff.raw.patch` with the
  current config, keeping `source` from the existing `ingest.json`.
- `spr validate` now also recognizes `ingest.json` and runs `checkIngest` on it.

## 10. Tests

- Golden samples: parse each `golden/*/diff.patch`; build ingest with the default config;
  output validates and `checkIngest` is clean; nothing is skipped and `diff.patch` equals
  the input. Every range in `labels.json` (`must_find` and `acceptable` items that have
  lines), every finding and dropped finding with lines in `review.expected.json`, and every
  script `focus` must pass `hasRange` on the new side. Every `evidence` snippet must pass
  `containsSnippet`. Check line 19 of sample 01's handler is
  `await this.dataSource.transaction(async (manager) => {` (trimmed).
- Parser fixtures in `test/fixtures/diffs/`: rename with edits, pure rename, copy, deleted
  file, binary, mode-only change, no newline at end of file, quoted paths (space, quote and
  non-ASCII), multiple hunks in one file, CRLF content, plain unified diff, format-patch
  preamble, and malformed inputs (wrong counts, stray line, hunk before header).
- Filter and risk tables; budget truncation is deterministic and keeps diff order.
- Git integration (real `git` in a temp dir; set `GIT_CONFIG_GLOBAL` to a temp file that
  contains `diff.noprefix=true`, `color.ui=always`, `diff.external=false`, and
  `commit.gpgsign=false` so hostile user config is proven harmless): commits that add,
  modify, rename, delete, add a lockfile and a binary file. Check `A..B` and `A...B`
  (on a branch), shas, statuses, skip reasons, `ref`, and rejection of `--output=x..y`.
- Determinism: two ingests of the same input give byte-identical files.
- CLI: `run --diff <golden> --until ingest --out <tmp>` exits 0 and writes the three files;
  without `--until` it exits 2 with the message above; a non-empty `--out` without
  `--force` fails with one clear line; `stage ingest` re-filters after a config change
  (use `SPR_CONFIG` with an extra ignore glob).

No network in tests.

## 11. Finish

1. `pnpm verify`, `pnpm format:check` and `pnpm build` pass.
2. Smoke test on this repo: `pnpm spr run --git HEAD~1..HEAD --until ingest` and show the
   summary line.
3. Commit as "Milestone 1 step 2: ingest" (separate commits are fine), push, and tell me to
   check CI.
4. Set step 2 to done and step 3 to next in docs/ROADMAP.md.
5. Report: files added, anything you changed from this plan and why, and any open questions.
   Do not start step 3.
