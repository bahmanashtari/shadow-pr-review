# Adding the video review to a service repository

For a team that wants reviews on their pull requests. You need a workflow file and a runner; you
do not need Node, pnpm, Playwright, ffmpeg or an API key in your repository, because the review
runs inside a published image.

Everything here is what the tool actually does today, not a plan. The design is in
`docs/ARCHITECTURE.md` and the reasons in `docs/DECISIONS.md`.

## 1. The workflow

Copy this into `.github/workflows/video-review.yml` in your service repository:

```yaml
name: video-review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths-ignore: ["docs/**", "**/*.md"]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: video-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    uses: bahmanashtari/shadow-pr-review/.github/workflows/video-review.yml@v0.1.0
    with:
      runs-on: self-hosted      # a machine with Ollama; see section 2
    permissions:
      contents: read
      pull-requests: write
```

Pin `@v0.1.0` rather than `@main`, so a change here cannot change your reviews without you.

**Inputs**, all optional except the runner in practice:

| Input | Default | What it is for |
|---|---|---|
| `image` | `ghcr.io/bahmanashtari/shadow-pr-review:edge` | Pin a version: `:v0.1.0`, or a digest. |
| `runs-on` | `ubuntu-latest` | The runner. A local model needs a self-hosted one. |
| `llm-provider` | the configured local model | `fake` reviews with the deterministic checks alone; `anthropic` uses a hosted model and a key. |
| `kokoro-image` | pinned Kokoro CPU image | The voice. |
| `commit-comments` | `false` | Comment on a commit for a push with no pull request. Needs `contents: write`. |
| `skip-label` | `skip-video-review` | The label that skips a pull request. |
| `timeout-minutes` | `30` | |

## 2. The runner

The review runs a 30-billion-parameter model locally, which is what keeps it free and keyless
(ADR-015). **A GitHub-hosted runner cannot hold it**: a hosted runner on a private repository has
2 CPUs and 8 GB of memory and no GPU. So you need one of:

- **A self-hosted runner with Ollama** and `qwen3:30b` pulled - a team machine that is awake when
  pull requests are opened. This is the intended setup (ADR-051). GitHub's own advice is to use
  self-hosted runners with private repositories only, because anyone who can change a workflow
  can run code on that machine.
- **`llm-provider: fake` on a hosted runner.** No model at all: the deterministic checks still
  find migrations that will fail, missing idempotency keys and the like, and you still get a
  video and a comment. A cheap way to try the plumbing.
- **`llm-provider: anthropic` with your own key**, passed as the `anthropic-api-key` secret.
  Fast and good, and billed to you. Never the default (ADR-015).

The Kokoro voice container is started by the workflow as a service container; it is CPU-only and
needs nothing from you.

## 3. What you get

A single comment on the pull request, updated in place on every push rather than repeated:

- what was found, on which commit, by severity, and a link to the video with its length
- which files were reviewed, what was skipped and why, and whether the diff was cut to its
  riskiest files
- a table of findings, each linked to its exact lines at the reviewed commit
- each finding's reasoning and suggested fix, collapsed

The video is uploaded as a build artifact and linked from the comment; GitHub serves it as a
signed-in download rather than streaming it (ADR-062). **A review that finds nothing makes no
video** and updates the comment to say so, so a pull request whose findings were fixed stops
showing them.

## 4. Turning it off for one change

Any of these skip the review:

- the pull request is a **draft**
- a **`skip-video-review` label** on it (rename it with `skip-label`)
- **`[skip review]`** in the title
- the change touches only the paths in your `paths-ignore`

A push to a branch that already has an open pull request is skipped too, because that pull
request's own run covers it.

## 5. What it costs, and what it does with your code

- **Time**: a few minutes per pull request. The recording runs in real time, so a 40-second video
  takes 40 seconds to record, and the review itself is the slow part on a local model.
- **Storage**: one `final.mp4` per run against your Actions artifact quota, 30 days by default.
- **Money**: nothing, unless you choose the hosted model.

Your code is read, never executed: no build, no test suite, no `tsc`, no `eslint`, no install
step (ADR-062). The model sees the diff, and - when the workflow checks out the pull request's
head - the changed files at that commit. Nothing is sent anywhere except to the model you chose:
with the default, that is a process on your own runner.

**A pull request from a fork** is reviewed and the video uploaded, but the comment is not posted:
GitHub gives a fork's workflow a read-only token, and the job says so once rather than failing.

## 6. When something goes wrong

The job's own log needs admin rights on the repository, so the workflow puts the tool's output
where anyone can read it: the **job summary** carries the tail of every run, and a failure also
becomes an **annotation** on the run, which is what you see without opening the log.

The run folder is kept on the runner, and every stage can be re-run from it alone
(`spr stage <name> --run runs/current`), so nothing is reviewed or spoken twice while a later
stage is being fixed.

If the review is wrong about something, that is worth reporting: the tool is measured against
nine samples written for it, and real pull requests are where it is weakest (ADR-062).
