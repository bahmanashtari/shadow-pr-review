# Plan: Milestone 4, step 1 (`--pr`: review a GitHub pull request)

Status: **approved** by Bahman on 21 September 2026, every recommendation taken. Q1: start
Milestone 4 now. Q2: a self-hosted runner on a dedicated team machine, running Ollama with the
default model (the roadmap's Milestone 4 section records it; step 4 builds on it). Q3: `fetch`.
Q4: public and private repositories from the start. Two facts in the body below turned out wrong
when checked, and are corrected here rather than rewritten there. A hosted runner for a *private*
repository has 2 CPUs and 8 GB, not the 16 GB of a public one, which weakens Q2's second option
further. And `actions/checkout` on a `pull_request` event checks out the test merge commit, not
the PR's head, so the checkout rule in section 3 is not met by default; the step 4 workflow has to
ask for `ref: ${{ github.event.pull_request.head.sha }}` (ADR-051).

Originally written as `proposed` at the end of the session that finished Milestone 3's steps 2, 3,
7 and 13 to 15, so the next session can put its questions to Bahman and start rather than
reconstruct. Milestone 3 is done apart from two steps that wait on him (4, the real samples; 5,
a sandboxing decision), and neither blocks this one. **Do not rewrite this plan; amend its status
when it is approved.** Read CLAUDE.md, docs/ROADMAP.md, ARCHITECTURE sections 1, 2 and 4, and
`docs/cheatsheets/github-integration.md` first.

## 0. Before starting: one end-to-end run

Milestone 3 changed the Reviewer's prompt and message (ADR-044, ADR-047, ADR-049) and Verify's
rules (ADR-046, ADR-047), and six of the nine golden samples - 04 to 09 - have never been through
the video path. CLAUDE.md says to run `pnpm tsx scripts/end-to-end.ts` before a release and after
touching a stage boundary; do it first, so Milestone 4 starts from a known-good pipeline. It needs
Ollama, the Kokoro container and ffmpeg. **Docker is shared with Bahman's other project**: bring
up only this repository's compose project and take only that down, never quit Docker Desktop
while other containers run (see the local-environment memory). Expect 07 and 09, and 03 on some
runs, to make no video - that is correct (ADR-042). Sample 06 is the first modified-file diff to
reach the Recorder; its page was checked by hand this session and rendered correctly.

## 1. What the step is

`spr run --pr 142 --repo owner/name` exists in the CLI today and exits 2 ("not implemented yet").
The step makes it produce the same ingest outputs as `--git`: `diff.raw.patch`, `diff.patch` and
`ingest.json`, with `source.type = "pull_request"`, the PR number, base and head SHAs, the head
branch and the PR's title. Everything downstream already works from those files.

Two GitHub calls do it: the pull request as JSON (`GET /repos/{owner}/{repo}/pulls/{n}` - title,
SHAs, branch, draft state) and the same endpoint with `Accept: application/vnd.github.diff` for
the diff. **Check the current GitHub REST documentation before building**: the media type, the
size limit on the diff response, and the rate limits all change, and this plan's knowledge of them
may be out of date.

## 2. Decisions to take

**Q1. Start Milestone 4 now? Recommendation: yes.** Milestone 3's two open steps wait on Bahman
and neither is needed for this one. The alternative is to hold Milestone 4 until the real samples
arrive, so the tool is measured on real code before it posts on real pull requests - a fair
choice, and his.

**Q2. Where does the model run when this runs in CI? This shapes the whole milestone, and needs
an answer before step 4, not before step 1.** The pipeline's default is a local `qwen3:30b` with no
API key (ADR-015), and CLAUDE.md forbids making a paid provider the default. A standard GitHub
hosted runner has no GPU and about 16 GB of memory, which cannot hold a 30B model. The options:

- A self-hosted runner with Ollama - a team machine, or this one. Keeps ADR-015 whole; needs a
  machine that is on when pull requests are opened. **Recommended, if such a machine exists.**
- A smaller model on a hosted runner. `qwen3:4b` matched the default's recall on the golden set but
  was 1.5 times slower even with a GPU (ADR-045); on a CPU-only runner it may take far longer than
  a pull request should wait. Would need measuring.
- The hosted API, opt-in, with the team's own key - the path CLAUDE.md already allows for whoever
  supplies a key. Fast and good; billed.

**Q3. Octokit or plain `fetch`? Recommendation: `fetch` for this step.** CLAUDE.md lists
`@octokit/rest` as planned. Two GET requests do not need it, Node 22 has `fetch`, and a small
injected client keeps unit tests network-free. Step 2 (a sticky comment: find, then create or
update, across paginated comments) is where Octokit's pagination and retries start to pay, so the
choice can be revisited there without undoing anything.

**Q4. Which repositories first - public or private?** A public repository needs no token (60
unauthenticated requests an hour is plenty for development); a private one needs `GITHUB_TOKEN`
from the environment, never from a file (CLAUDE.md). Recommendation: support both from the start,
since the token is only a header, and make the error for a missing token on a private repository
say exactly that.

## 3. Scope

- `src/ingest/sources.ts`: `fromPullRequest(number, repo, options)` beside `fromGitRange`,
  returning the same `DiffSource`. The HTTP client is injected, so tests pass fixtures and never
  touch the network (CLAUDE.md). Run folder id: `pr<number>-<short head sha>`.
- `src/cli.ts`: wire `--pr` / `--repo` into `spr run` in place of the `notYet` call; `--repo`
  defaults to the `origin` remote's GitHub repository when omitted, as `--git` already parses it.
- **A checkout only when there is one.** `read_file` and `grep_repo` need the repository at the PR's
  head. Offer them only when the working directory is a git checkout whose `HEAD` is the PR's head
  SHA - which is exactly what `actions/checkout` gives the workflow in step 4 - and not otherwise.
- A diff too large for the API's diff response fails with one clear line naming the limit and
  pointing at `--git` on a checkout; ingest's own size cap already handles the large-but-allowed
  case.
- Drafts are reviewed when asked for explicitly; skipping them is the workflow's job (step 4,
  ARCHITECTURE section 4), not the source's.
- Tests: a PR fixture (JSON plus diff) through `fromPullRequest` gives the same ingest files as the
  same diff through `--diff`, apart from `source`; the token header is sent when present and not
  otherwise; a 404, a 403 rate limit and an oversized diff each give one clear line.

## 4. What to check

- `pnpm verify`, `pnpm format:check`, `pnpm build`.
- One real run against a small public pull request, through to `final.mp4`, with the model and
  Kokoro up - and its narration read, since this is the first diff the golden set did not write.
- CLAUDE.md's command section moves `spr run --pr` from "registered but not built" to "runs".

## 5. Finish

An ADR for the choices taken (Q3, Q4, the checkout rule), the roadmap status, commit, push, CI.
Q2 is recorded as open until Bahman answers it, in the roadmap's Milestone 4 section.
