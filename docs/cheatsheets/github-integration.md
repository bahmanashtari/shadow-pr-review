# Cheat sheet: GitHub integration (Actions)

> Snapshot written September 2026. Action versions, permissions and API details change.
> Verify against docs.github.com, and pin actions to a version or commit SHA.

## Workflow

```yaml
# .github/workflows/shadow-pr-review.yml
name: shadow-pr-review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches-ignore: [main]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: spr-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    if: >-
      (github.event_name == 'pull_request' && github.event.pull_request.draft == false
        && !contains(github.event.pull_request.labels.*.name, 'skip-video-review'))
      || github.event_name == 'push'
    # The model needs a machine that can hold it: a self-hosted runner on a dedicated team
    # machine running Ollama (ADR-051). A hosted runner for a private repository has 2 CPUs and
    # 8 GB. Self-hosted runners are for private repositories only.
    runs-on: ubuntu-latest
    timeout-minutes: 25

    services:
      kokoro:
        image: ghcr.io/remsky/kokoro-fastapi-cpu:latest   # pin a tag
        ports:
          - 8880:8880

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # On pull_request the default is the test merge commit. read_file and grep_repo are
          # offered only on a checkout at the reviewed head (ADR-051), so ask for the head.
          ref: ${{ github.event.pull_request.head.sha || github.sha }}

      - name: Skip push if the branch has an open PR
        if: github.event_name == 'push'
        id: prcheck
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          count=$(gh pr list --head "${GITHUB_REF_NAME}" --state open --json number --jq 'length')
          echo "has_pr=$([ "$count" -gt 0 ] && echo true || echo false)" >> "$GITHUB_OUTPUT"

      - uses: actions/setup-node@v4
        if: steps.prcheck.outputs.has_pr != 'true'
        with:
          node-version: 22

      - name: Set up tooling
        if: steps.prcheck.outputs.has_pr != 'true'
        run: |
          sudo apt-get update && sudo apt-get install -y ffmpeg
          corepack enable
          pnpm install --frozen-lockfile
          pnpm exec playwright install --with-deps chromium

      - name: Wait for Kokoro
        if: steps.prcheck.outputs.has_pr != 'true'
        run: timeout 240 bash -c 'until curl -sf http://localhost:8880/health; do sleep 3; done'

      - name: Run review (PR)
        if: github.event_name == 'pull_request'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          pnpm spr run --pr ${{ github.event.pull_request.number }} \
            --repo ${{ github.repository }} --out runs/current

      - name: Run review (push)
        if: github.event_name == 'push' && steps.prcheck.outputs.has_pr != 'true'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          BEFORE="${{ github.event.before }}"
          if [ "$BEFORE" = "0000000000000000000000000000000000000000" ]; then
            BEFORE="$(git merge-base origin/main HEAD)"   # new branch: diff against main
          fi
          pnpm spr run --git "$BEFORE..${{ github.sha }}" --out runs/current

      - name: Upload video
        if: steps.prcheck.outputs.has_pr != 'true'
        id: upload
        uses: actions/upload-artifact@v4
        with:
          name: review-video-${{ github.sha }}
          path: |
            runs/current/final.mp4
            runs/current/subtitles.srt
            runs/current/review.json
          retention-days: 30

      - name: Post sticky PR comment
        if: github.event_name == 'pull_request'
        env:
          GITHUB_TOKEN: ${{ github.token }}
          ARTIFACT_URL: ${{ steps.upload.outputs.artifact-url }}
        run: pnpm spr publish --pr ${{ github.event.pull_request.number }} --run runs/current --video-url "$ARTIFACT_URL"
```

## Running it from your service repositories

The workflow above lives in the tool's own repo for development. For your service repos,
publish the tool as a Docker image (Playwright Node base + ffmpeg + built `dist/`) and
use it from a short workflow, so services need no Node setup for the tool:

```yaml
      - name: Video review
        run: |
          docker run --rm --network host \
            -e ANTHROPIC_API_KEY -e GITHUB_TOKEN \
            -v "$PWD:/repo" -w /repo \
            ghcr.io/<your-org>/shadow-pr-review:<version> \
            run --pr ${{ github.event.pull_request.number }} --repo ${{ github.repository }} --out runs/current
```

`--network host` lets the container reach the Kokoro service on `localhost:8880`.
A composite or reusable workflow (`workflow_call`) can wrap all of this later.

## Sticky comment

Put a hidden marker in the body, find it on each run, and update instead of posting again.

```text
<!-- shadow-pr-review -->
### Video review
**3 findings** (1 high, 1 medium, 1 low) · [Watch the walkthrough](ARTIFACT_URL) · 2m 10s
| Severity | File | Summary |
|---|---|---|
| high | order-service/.../place-order.handler.ts#L19-L27 | Event published before commit |
```

REST calls (the `spr publish` command wraps these):
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
