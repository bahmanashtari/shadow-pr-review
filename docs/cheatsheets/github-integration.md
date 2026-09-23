# Cheat sheet: GitHub integration (Actions)

> Snapshot written September 2026. Action versions, permissions and API details change.
> Verify against docs.github.com, and pin actions to a version or commit SHA.

## Workflow

Built, not sketched: `.github/workflows/video-review.yml` is the reusable workflow, and
`.github/workflows/self-review.yml` is this repository calling it on its own pull requests
(ADR-056). A service repository needs only the caller:

```yaml
# .github/workflows/video-review.yml in the service repository
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
    uses: bahmanashtari/shadow-pr-review/.github/workflows/video-review.yml@main
    with:
      # The model needs a machine that can hold it (ADR-051). Without one:
      # llm-provider: fake, which reviews with the deterministic analyzers alone.
      runs-on: self-hosted
    permissions:
      contents: read
      pull-requests: write
```

The reusable workflow's inputs: `image` (default `ghcr.io/bahmanashtari/shadow-pr-review:edge`),
`runs-on`, `llm-provider`, `kokoro-image`, `commit-comments`, `skip-label` and `timeout-minutes`;
its one optional secret is `anthropic-api-key`, for the opt-in hosted model. What it does, in
order: check out **the pull request's head** (not the merge commit, ADR-051), wait for the Kokoro
service container, skip a push whose branch already has an open pull request, run the image, upload
`final.mp4` as an artifact, and post the sticky comment with that artifact's URL.

## Running the image directly

The caller above is the normal route. This is what it does inside, and what to copy if a
repository would rather run the image itself than call the reusable workflow:

```yaml
      - name: Video review
        run: |
          docker run --rm --network host \
            --user "$(id -u):$(id -g)" --ipc=host --shm-size=1g -e HOME=/tmp \
            -e ANTHROPIC_API_KEY -e GITHUB_TOKEN \
            -v "$PWD:/repo" \
            ghcr.io/<your-org>/shadow-pr-review:<version> \
            run --pr ${{ github.event.pull_request.number }} --repo ${{ github.repository }} --out runs/current
```

`--network host` lets the container reach the Kokoro service on `localhost:8880`. The image's
working directory is already `/repo`; `--user` keeps the run folder owned by the runner, and
Chromium needs `--ipc=host --shm-size=1g` (ADR-053). Posting is a second `docker run`, after the
artifact upload that gives the video its URL:
`stage publish --run runs/current --video-url "$ARTIFACT_URL"` (ADR-052).

## Sticky comment

Put a hidden marker in the body, find it on each run, and update instead of posting again.

```text
<!-- shadow-pr-review -->
### shadow-pr-review

**3 findings** on `6c30f9d`: 1 high, 1 medium, 1 low. [Watch the walkthrough](ARTIFACT_URL) (0:42).

Reviewed 1 file.

| Severity | Where | Finding |
|---|---|---|
| high | [place-order.handler.ts#L19-L27](permalink at the head sha) | Event published before commit |

<details><summary>high · Event published before commit</summary> ... rationale, suggested fix
```

REST calls (`spr stage publish` wraps these; ADR-052 matches a comment only when its body
*starts* with the marker, so a quoted marker is never updated):
- List: `GET /repos/{owner}/{repo}/issues/{pr}/comments` (find the marker)
- Create: `POST /repos/{owner}/{repo}/issues/{pr}/comments`
- Update: `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`
- Commit comment (push mode): `POST /repos/{owner}/{repo}/commits/{sha}/comments`
  (needs `contents: write`; only add it if push mode is enabled)

## Video hosting options

GitHub's API cannot upload a video attachment to a comment. Options (see ADR-008):
1. Actions artifact (above): free; signed-in users download a zip; retention-limited.
2. S3-compatible storage: upload `final.mp4`, put a presigned or public URL in the comment;
   plays in the browser. Small storage cost.
3. Release asset on a dedicated pre-release: free; visibility follows the repo.

## Security

- Use `pull_request`, not `pull_request_target`, when running code from the PR.
  Secrets are not available to workflows from forks under `pull_request`. The pipeline needs
  no API key by default (ADR-015: a local Ollama model), so the job must not require
  `ANTHROPIC_API_KEY`; the model runs on a self-hosted runner (ADR-051), and GitHub's advice is
  to use self-hosted runners only with private repositories, since whoever can change a
  workflow runs code on that machine.
- The Reviewer only reads files; it never executes code from the PR.
- Diff content is untrusted input to the LLM (prompt injection). Prompts must say so, and
  the Verifier's deterministic checks limit the damage.

## Cost guards

- Skip drafts, bots (for example Dependabot), docs-only changes (`paths-ignore`), and the
  `skip-video-review` label.
- `concurrency` cancels superseded runs.
- Cache: Playwright browsers (`~/.cache/ms-playwright`), pnpm store, and the run cache keyed
  by diff hash.
- Cap diff size; above it, review top-risk files only.
