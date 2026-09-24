# Plan: Milestone 3, step 21 (show the changed files, instead of offering to)

Status: **done** on 24 September 2026 (ADR-061). Written at the end of step 19 (ADR-060) and taken
the same day under Bahman's standing instruction to take a plan's recommendation and record it:
the whole changed file, as recommended, capped at 20 KB per file and 32 KB in total. Read ADR-051,
ADR-054, ADR-059 and ADR-060 first.

## 1. What step 19 left

The tool's false positives on a real pull request (nestjs/nest#17816) are claims about code the
diff does not show. They cover how many times `initializeClientAndConnections` creates a
producer, and whether `this.initialized` may hold null. Step 19 made `read_file` and `grep_repo`
reachable on Ollama for the first time, and told the Reviewer to read before asserting. In four
runs it called no tool, and one run made the same claim, in prose, in the turn where it could have
looked (ADR-060). Offering the code is not enough for this model. The code has to be in front of it.

Both claims rested on `packages/microservices/client/client-kafka.ts`, **a file the pull request
itself changed**. The method body sits below the hunk that cuts it off, and the declaration sits
at line 62, above the first hunk.

## 2. What to build

With a checkout - and only then, so the golden set's prompts do not move - the Reviewer's `user`
message carries each changed file at the head revision after the diff, as context:

- One block per added or modified file, numbered the way the diff is, under a heading that says it
  is the whole file at the head revision, for reading only. Findings still cite the diff: evidence
  is checked against the diff (ADR-019), and a finding on unchanged lines is still out of scope
  (ADR-047).
- Capped per file and in total, in lines and bytes, with the largest files cut first and a note
  saying so. The allocated context is 32,768 tokens, and on this pull request the system prompt and
  the diff already use about a sixth of that (4,868 input tokens).
- Read from the checkout that `checkoutAt` already verified is at the reviewed head. No new
  source, no network. The content is as untrusted as the diff, so it stays in the `user` message,
  never in the system prompt (ADR-049).
- Deleted files and files the ingest filters skipped are not shown.

## 3. How it is measured

The golden set cannot measure this, because no sample has a checkout. It proves only that nothing
moved: the warm `spr eval` must come entirely from the cache, as it did in ADR-060. The measurement
is the pull request, run as ADR-060 ran it - once greedy and three seeds - and read for three
things: whether either false positive survives, whether the new material creates findings on
unchanged code (the `out_of_scope` drops will show them), and what the longer prompt costs in
seconds.

**The honest limit.** One pull request is one data point. With the real samples of step 4, this
step's evidence could be a set. Until then, it is a mechanism that removes a demonstrated cause,
checked on the one case that demonstrated it.

## 4. Options considered

- **The whole changed file (recommended).** Simple, and it covers both claims above.
- **Only the enclosing function of each hunk.** Cheaper, but finding a function's boundaries
  means parsing TypeScript. It would have caught the method body and missed the declaration at
  line 62.
- **A Verifier with tools** (ADR-060's option B). The model has now shown twice that it does not
  use tools it is offered, so this would add a second agent with the same habit.

## 5. What to check

- A unit test that a checkout adds the blocks and a diff-only run's prompt is byte-identical.
- The caps: a file over the cap is cut and says so, and the total budget holds with many files.
- The golden set is served entirely from the cache after the change.
- The pull request: false positives, `out_of_scope` drops and seconds, against ADR-060's runs.
- `pnpm verify`, `pnpm format:check`, `pnpm build`.

## 6. Open questions

None that only Bahman can settle. Every recommendation above can be taken under his standing
instruction and recorded.
