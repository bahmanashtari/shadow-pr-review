# Plan: Milestone 4, step 2 (`spr publish`: the sticky pull request comment)

Status: **done** on 21 September 2026 (ADR-052), approved by Bahman with every recommendation
taken. Q1: a bare `spr run` renders `comment.md` and never posts. Q2: a fresh `spr run --force`
clears the pipeline's own named outputs first. Q3: commit comments wait for step 4. Q4: Bahman
makes the first real post himself, on a throwaway pull request in his repository. `fetch` stays.

**Q4 was then overtaken twice.** Bahman said he has no time to run commands or check pull
requests, so the first real post moved to step 4 - and there it happened without a pull request
at all: a push to `spr-live-post-check` posted a commit comment through the live API as
`github-actions[bot]` (ADR-056). The `spr-publish-test` branch this plan left waiting was never
needed and is deleted.

Written as `proposed` straight after step 1 landed (ADR-051), in the same session. Read
CLAUDE.md, docs/ROADMAP.md, ARCHITECTURE section 2.9 and 4, ADR-008, ADR-042 and ADR-051, and
`docs/cheatsheets/github-integration.md` first.

## 1. What the step is

`spr stage publish --run runs/<id>` exists and exits 2 ("not implemented yet"). The step makes it
post the review to the pull request as **one sticky comment**, updated in place on every push
rather than posted again, with a link to the video when there is one. It is the pipeline's only
outward-facing act: everything before it writes files; this writes on someone's pull request.

Everything it needs is already on disk. `review.json` carries `source` (repository, number, head
sha), the summary, the kept findings with file, lines, severity, rationale and suggestion, and the
stats; `ingest.json` says whether the diff was truncated to its riskiest files; `final.mp4` and
`timeline.json` give the video and its length. The video's *link* is not on disk: in CI the
workflow uploads `final.mp4` as an artifact and only then knows its URL (ADR-008, option 1), so
Publish takes it as `--video-url`, and hosting it anywhere better is step 5.

## 2. Decisions to take

**Q1. Should a bare `spr run` ever post? Recommendation: never.** Today `spr run` walks to Compose
and exits 2 at `publish`. Proposed: the publish stage inside `spr run` *renders* the comment to
`comment.md` in the run folder and stops there, exit 0, so a developer can read exactly what would
be posted; posting is always the separate, deliberate `spr stage publish`. Two reasons. A person
running `spr run --pr 142` locally to try the tool should not find they have commented on a
colleague's pull request. And CI has to post as a separate command anyway, because the artifact
upload that produces the video URL runs between Compose and Publish. The alternative is a
`--publish` flag on `spr run`; it would only ever be used without a video link.

**Q2. The stale video. Recommendation: a fresh `spr run` removes its own earlier outputs first.**
ADR-051 found that `--force` writes into a run folder without clearing it, so a re-run whose review
keeps nothing - or that stops early with `--until` - leaves the previous run's `script.json`,
audio, `final.mp4` and the rest beside the new `review.json`. Publish would link a video about
findings that no longer exist. Options:

- **At the start of `spr run --force`, delete the pipeline's own named outputs** - the fixed list
  CLAUDE.md gives (`review.raw.json` through `cost.json`, and `audio/`), never the folder and never
  a file not on that list. The folder then always describes one run, for every reader: Publish,
  the end-to-end script, and a person watching `final.mp4`. `spr stage <name>` keeps reusing the
  folder as it does now, which is its purpose. **Recommended.**
- A check inside Publish only: attach the video only when `script.json`'s finding ids match
  `review.json`'s and `final.mp4` is newer than both. Contained, but mtime-based, and it protects
  Publish while leaving the folder misleading for everyone else.
- Both.

**Q3. Commit comments for pushes. Recommendation: defer to step 4.** The roadmap scopes "optional
commit comment for pushes" into this step. It is off by default (ARCHITECTURE section 4), needs
the broader `contents: write` permission, and has no caller until the workflow's push path exists.
Built now it would be code with no reader. Step 4 adds it with the push path, as a second target
for the same rendered body.

**Q4. The first real post. Recommendation: Bahman runs it once, on a throwaway pull request in
`bahmanashtari/shadow-pr-review`.** Unit tests cover the logic with a fake `fetch`, as in step 1.
But the create-then-update round trip against GitHub has to be seen once, and it cannot happen
from this session: posting is an outward-facing action, the session has no GitHub token (the one
in the keychain is not the session's to use), and there is no `gh` here. The session prepares a
branch and a run folder; Bahman opens the pull request, exports a token and runs two commands -
one to create the comment, one to watch it update. The alternative is to leave the first real
post to step 4's workflow on the same repository, where `GITHUB_TOKEN` is provided.

**Not asked, recommended unless Bahman says otherwise:** keep `fetch` (ADR-051 promised to revisit
Octokit here). Finding the sticky comment means listing comments 100 to a page and following the
`Link` header, which is a few lines; the injected client and its tests carry over unchanged.

## 3. The comment

```text
<!-- shadow-pr-review -->
### Video review
**2 findings** on `6c30f9d` - 1 high, 1 low · [Watch the walkthrough](URL) · 0:42

| Severity | Where | Finding |
|---|---|---|
| high | [place-order.handler.ts#L19-L27](permalink) | Event published before the transaction commits |
| low | [order.controller.ts#L8](permalink) | ... |

<details><summary>high · Event published before the transaction commits</summary>

(rationale)

**Suggested fix:** (suggestion)
</details>
```

- **Every finding is in the text, not only in the video**, collapsed. A reviewer who will not watch
  a 40-second video for a one-line issue still gets the reasoning and the fix, which is the purpose
  ADR-042 gave the video in the first place.
- **Links are permalinks at the head sha**, `https://github.com/<repo>/blob/<sha>/<path>#L19-L27`,
  so they still point at the reviewed lines after the next push.
- **A clean review still updates the comment**: "No findings on `abc1234`", with the file counts.
  Otherwise a pull request whose findings were fixed keeps showing the old ones, which is worse
  than posting nothing. With no video there is no link (ADR-042).
- **A truncated diff says so** (ARCHITECTURE section 4): "Reviewed the N riskiest files of M."
- **No video link without `--video-url`**, and the line says the video is in the run folder
  instead; a local `comment.md` is still complete.

**The body is untrusted text.** Summaries, rationales and suggestions are model output written
after reading a diff that anyone opening a pull request controls (ADR-049), and evidence is the
diff itself. Before it goes into markdown: `@` is neutralised so nothing pings anyone; HTML tags
and markdown images are escaped so nothing renders or loads from elsewhere; `|` and newlines are
escaped inside table cells; the marker cannot appear anywhere but the first line; and the body is
capped well under GitHub's comment limit (not stated on the endpoint's page; 65,536 characters is
the observed one - check). Tests feed each of these through.

**Finding the sticky comment.** List the pull request's issue comments, take the newest whose body
*starts* with the marker, and `PATCH` it; if there is none, `POST` one. A marker quoted by a person
mid-comment is never matched. If the update is refused (the comment belongs to another account -
a token change, say), post a new one rather than fail, and say so.

## 4. Scope

- `src/publish/comment.ts` (pure): review, ingest facts, video length and URL in; markdown out.
  Sanitising lives here, unit-tested without I/O, like the Director.
- `src/publish/publish.ts`: the stage - reads the run folder, renders, writes `comment.md`, and
  with a pull request source and not `--dry-run`, finds and creates or updates the comment.
- `src/lib/github.ts`: `listIssueComments` (paginated), `createIssueComment`,
  `updateIssueComment`, with the same one-line failures as step 1, plus a 403 on write that names
  the missing `pull-requests: write` permission.
- `src/cli.ts`: `spr stage publish --run <dir> [--video-url <url>] [--dry-run]`; `spr run` renders
  only (Q1). A run whose source is not a pull request renders and says there is nothing to post
  to, exit 0.
- If Q2 is taken: the output list in one place (`src/lib/run-folder.ts`), cleared at the start of
  `spr run --force`, with a test that a file not on the list survives.
- `scripts/end-to-end.ts` expects exit 0 and a `comment.md` instead of exit 2 at `publish`.
- Tests: rendering (findings, clean, truncated, no URL, every sanitising rule); the find-or-create
  logic against fake responses (no comment, one, several, a quoted marker, a refused update, a
  second page); the CLI with a stubbed `fetch`, as step 1 did.

## 5. What to check

- `pnpm verify`, `pnpm format:check`, `pnpm build`.
- `comment.md` rendered for the nine golden samples and nestjs/nest#17816, and read.
- The real post (Q4).
- CLAUDE.md's commands move `spr stage publish` to "runs", and "exits 2 at publish" goes wherever
  it is said.

## 6. Finish

An ADR for Q1 to Q4 and the comment's shape, the roadmap status, commit, push, CI.
