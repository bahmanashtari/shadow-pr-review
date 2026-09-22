# Plan: Milestone 4, step 4 (the workflow service repositories add)

Status: **proposed**, written straight after step 3 (ADR-053). Read CLAUDE.md, docs/ROADMAP.md,
ARCHITECTURE sections 4 and 5, `docs/cheatsheets/github-integration.md`, and ADR-051 to ADR-053
first.

## 1. What the step is

One workflow file a service repository can copy, which runs the image from step 3 on its pull
requests and posts the sticky comment from step 2. It is also where three things that have been
deferred land: the trigger policy (ARCHITECTURE section 4), fork and draft handling, and the
optional commit comment for pushes (moved here from step 2 by ADR-052). And it is where Publish
finally meets the real API, with the token Actions provides - the proof ADR-052 left open.

## 2. What it has to get right

- **Triggers.** `pull_request` on opened, synchronize, reopened and ready_for_review; skip drafts;
  skip the `skip-video-review` label and `[skip review]` in the title; `concurrency` with
  `cancel-in-progress`, so only the newest push on a branch is rendered.
- **The checkout must be the pull request's head**, not the test merge commit
  `actions/checkout` gives by default, or `read_file` and `grep_repo` are withheld (ADR-051) -
  which is exactly what produced the one false positive this tool has made on a real pull
  request.
- **Forks.** Under `pull_request` a fork's token is read-only, so the comment cannot be posted;
  the job must say so once, clearly, rather than fail. `pull_request_target` is not the answer:
  it would run with a writable token against code from the fork.
- **Where the model runs.** The self-hosted runner from ADR-051, named by an input or a variable
  so a repository without one can still run with `SPR_LLM_PROVIDER=fake` (the analyzers alone) or
  a hosted API key. The workflow must not require a paid key (ADR-015).
- **The video's link.** Upload `final.mp4` as an artifact, then pass the artifact URL to
  `spr stage publish --video-url` (ADR-008 option 1). A clean review has no video and the step
  still runs, because the comment must say the findings are gone (ADR-052).
- **Cost guards.** `paths-ignore` for docs-only changes, a timeout, and the diff size cap the
  tool already applies.

## 3. Decisions to take

**Q1. One reusable workflow, or a file each repository copies? Recommendation: a reusable
workflow (`workflow_call`) in this repository, plus a short caller each service repository
copies.** A caller of ten lines means a fix here reaches every service without a pull request
against each of them, which is the same argument that made the tool an image. The copy-the-file
alternative is easier to read and pin, and needs no cross-repository permission; it is the
fallback if `workflow_call` from a private repository turns out to need more setup than it saves.

**Q2. How this repository proves the workflow. Recommendation: run it here on
`SPR_LLM_PROVIDER=fake`, on a hosted runner.** This repository has no self-hosted runner, and the
fake provider still produces findings (the analyzers), a video and a comment - everything the
workflow orchestrates. The model's own quality is already measured by `spr eval`; what is unproven
is the plumbing: checkout at the head, artifact upload, the URL, the token, the comment.

**Q3. The first real post needs a pull request in this repository, and only a token can open
one.** `spr-publish-test` is pushed and waiting (ADR-052). The options: let a workflow open the
pull request itself with `GITHUB_TOKEN`, which needs the repository setting "Allow GitHub Actions
to create and approve pull requests" turned on; have Bahman open it with two clicks; or wait for
the next genuine pull request in this repository and let the workflow post on that.
**Recommendation: try the workflow-opens-it path, and fall back to waiting** - a genuine pull
request will come, and the workflow will be there when it does.

**Q4. Commit comments for pushes. Recommendation: build it, off by default.** ADR-052 moved it
here because it had no caller; now it does. It needs `contents: write`, so it stays behind an
input that defaults to false, and the same rendered body is posted to
`POST /repos/{owner}/{repo}/commits/{sha}/comments`.

## 4. Scope

- `.github/workflows/video-review.yml` in this repository: the reusable workflow
  (`on: workflow_call`), and a caller for this repository's own pull requests.
- `docs/cheatsheets/github-integration.md`: replaced by what was actually built, with the copy
  block a service repository needs.
- `src/publish/publish.ts` and `src/lib/github.ts`: the commit comment (Q4), behind a CLI flag.
- Tests for the commit-comment path, as step 2 did with a fake client.
- ARCHITECTURE section 4's table checked against what the workflow does, line by line.

## 5. What to check

- The workflow runs green here on a pull request, posts the comment, and the artifact link in it
  opens the video.
- A second push to the same pull request updates that comment instead of adding one.
- A draft pull request and a `skip-video-review` label are both skipped.
- `pnpm verify`, `pnpm format:check`, `pnpm build`.

## 6. Finish

An ADR for Q1 to Q4 and what the first real post showed, the roadmap status, commit, push, CI.
