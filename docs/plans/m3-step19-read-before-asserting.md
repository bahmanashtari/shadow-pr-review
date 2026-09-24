# Plan: Milestone 3, step 19 (the Reviewer asserts what unread code does)

Status: **done** on 24 September 2026 (ADR-060). Written while step 16's measurement ran, and
taken the same day under Bahman's standing instruction to take a plan's recommendation and record
it: option A, measured as section 4 describes. He was not asked, because nothing in it is his to
settle (section 6). The measurement found what this plan did not expect: on Ollama no tool call had
ever been possible, because the answer's schema is a grammar. That is fixed. Option A is kept for
parity but credited with nothing, and the model still reads nothing it is offered. The false
positive turned out to appear in one run of five. Step 21 takes the problem up by showing the
code instead of offering it. Read ADR-051 (the false positive), ADR-054 (the
re-run from a checkout that made no tool calls), ADR-047 and ADR-059 (why one run cannot judge a
prompt change, and what replaces it) first.

## 1. The problem, in its one real example

The tool's only false positive on a real pull request, nestjs/nest#17816, claims that a test
should expect two producer calls because "the producer is created in every connection attempt".
That is a claim about a method body the diff does not show. ADR-054 re-ran it from a checkout at
the pull request's head, with `read_file` and `grep_repo` both offered: the Reviewer made **zero
tool calls** and repeated the claim word for word.

## 2. What the prompt says today - found while writing this plan

`buildReviewerPrompt` (`src/agents/prompts/reviewer.ts`) has exactly one sentence against guessing
about unseen code, and it is in the **no-checkout** branch: *"You have the diff only ... do not
guess about code you have not been given."* When a checkout exists, that section is left out and
nothing replaces it. The tools arrive with their JSON descriptions and no word on when to use
them.

So the checkout did not merely fail to help in ADR-054. It removed the only instruction that
addressed the mistake. A diff-only run is told not to guess; a run that could have looked is told
nothing.

One correction to ADR-054 while here: it says the Verifier "has the same tools available and the
same habit of not using them". `judgeFindings` offers the Verifier no tools at all - it sees the
finding and the quoted code (ADR-037). A Verifier that checks claims against the repository would
be new work, not a prompt change.

## 3. Options

- **A. Say it where the tools are.** Give the checkout case its own "What you can see" section:
  the diff shows only what changed; before a finding asserts what code outside the diff does - a
  method body, a caller, a constructor, a configuration - read it with `read_file` or find it
  with `grep_repo`; a claim about code you have not read is a guess, so read it or leave the
  finding out. Small, and aimed at the exact failure.
- **B. A Verifier that checks claims against the repository.** Give the Verifier agent the
  read-only tools and a rubric line: drop a finding whose rationale rests on code outside the
  diff that it cannot confirm. Stronger in principle - a second reader - but the Reviewer's
  record says a model that is offered tools may not use them, and it doubles the tool budget.
- **C. Force the call.** Require at least one tool call before an answer when a checkout exists.
  Ollama has no forced tool choice, and a forced call that reads the wrong file proves nothing.

## 4. Recommendation: A, measured with step 16's seeds

A, because it changes the prompt **only when a checkout exists**. Every golden sample is a bare
diff with no checkout, so the golden set's prompts stay byte-identical. The warm `spr eval` then
proves there is no side effect at no cost: every answer should come from the cache. That removes
ADR-047's worry - an unrelated edit moving recall - by construction rather than by measurement.

The benefit is measured where the failure lives: nestjs/nest#17816 from a checkout at its head
(`6c30f9def880`), before and after, each at temperature 0 and at three seeds at 0.2 through
`llm.seed` in a config file (ADR-059). That is eight review-and-verify runs of about four minutes
each. The numbers that matter: how many runs report the false positive, and how many make a tool
call at all.

B stays on the roadmap if A does not move the tool-call count. C is not pursued.

## 5. What to check

- The golden set is served entirely from the cache after the change, with an identical score -
  the proof that the no-checkout prompt did not move.
- On the real pull request: tool calls per run, before and after, and whether the false positive
  survives. The claim is made against the seeds' spread, not one run.
- A unit test that the checkout prompt carries the new section and the no-checkout prompt is
  unchanged.
- `pnpm verify`, `pnpm format:check`, `pnpm build`.

## 6. Open questions

None that only Bahman can settle. The clone is of a public repository, read by `read_file` and
`grep_repo` only - nothing in it is executed. It runs through the built `dist/cli.js`, as ADR-054
did, so nothing reads the clone's own configuration. Under the standing instruction to take a
plan's recommendation and record it, A is the one to build.
