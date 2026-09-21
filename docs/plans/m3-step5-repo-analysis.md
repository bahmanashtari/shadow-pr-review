# Plan: Milestone 3, step 5 (repo-aware static analysis)

Status: **proposed, and deliberately not built.** Written under Bahman's instruction of 21 September
2026 to continue with whatever else could be done, but this step turns on a security decision that
is his: whether the tool may ever execute code from the repository it reviews, and under what trust
boundary. Nothing below should be built until he has answered section 3.

## 1. What the step is for

The analyzers (ADR-022) read one added line at a time. Some of the rubric's most damaging bugs need
more than a line: a promise nobody awaits needs the callee's type, an unsafe cast needs both types,
and a layering violation that crosses files needs the import graph. The roadmap names the tools:
`tsc` for floating promises and unsafe casts, `eslint` with the reviewed repository's own config,
and `dependency-cruiser` for the layer graph. All three need a checkout, and the useful versions
need its dependencies installed.

## 2. Why it cannot just be built

Running those tools the obvious way executes the reviewed repository's code:

- **Installing dependencies runs lifecycle scripts** (`postinstall` and friends) from every package
  in the tree - arbitrary code, with network access, as the user running the tool.
- **`eslint.config.js` is JavaScript**, and so are its plugins. Loading the repository's own config
  executes it.
- `dependency-cruiser` configs are JavaScript too.

On a developer's own machine, reviewing their own team's code, that is the same trust they already
extend when they run `npm test`. In Milestone 4 it is not: the tool runs in CI on pull requests,
and a pull request from a fork is code from anybody. ARCHITECTURE section 3 already treats forks
separately; this step would be the first thing in the pipeline that *executes* what a pull request
contains, rather than reading it.

## 3. The decision needed from Bahman

**A. Never execute the reviewed repository's code. Recommended as the first step.** Use the
TypeScript compiler API in-process - our pinned version, our settings, no install, no config file
from the repository loaded as code - on the checkout's `.ts` files. It can build the import graph
for the cross-file layer check, and it can find some unsafe casts. It cannot resolve types from
dependencies that were never installed, so floating promises on a library call are out of reach.
Safe everywhere, including forks, and a real improvement on line-at-a-time rules.

**B. Execute the toolchain, sandboxed, for trusted changes only.** A container with no network after
an `npm ci --ignore-scripts` install, the checkout mounted read-only, no secrets in the environment,
CPU and time limits - and only for pull requests from branches of the repository itself, never from
forks. Gets the full `tsc` and `eslint` checks, including the repository's own rules, at the cost of
an image to maintain and a trust rule to get right.

**C. Both: A everywhere, B added for trusted changes.** The likely end state, if B is wanted at all.

The questions are: is B ever acceptable, and if so, is "a branch of the same repository" the right
line for trust? Until they are answered, A is the only part that can be built.

## 4. Scope of A, if approved

- `src/analyzers/repo/`: an in-process pass over a checkout (`--git` and, later, `--pr` runs have
  one; `--diff` runs do not, and skip it), producing findings in the analyzers' existing shape so
  Verify, the eval and the video treat them like any other.
- First rule: a layer import that crosses the DDD boundary through a re-export in another file,
  which the line rule cannot see.
- A golden sample whose bug is only visible across files, since every current sample is visible in
  one hunk - which also means `spr eval` gains a checkout for that sample, a change to how golden
  samples are stored. That is its own design question and is left for the plan's approval.
