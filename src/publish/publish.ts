/**
 * The Publish stage (ADR-052): renders the verified review as the sticky comment, writes it to
 * `comment.md`, and - only when asked - posts it on the pull request, updating the comment an
 * earlier run posted instead of adding another.
 *
 * Rendering always comes first and always lands on disk, so a post that fails leaves the exact
 * text behind for a person to post or fix. `spr run` stops there; posting is the separate,
 * deliberate `spr stage publish`, because it is the one thing this tool does that other people
 * see.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FINAL_FILE } from "../composer/compose.js";
import { readTimeline, TIMELINE_FILE } from "../director/direct.js";
import { readIngest } from "../ingest/ingest.js";
import { StageError } from "../lib/errors.js";
import { GitHubError, type GitHubClient } from "../lib/github.js";
import { readReview } from "../verify/verify.js";
import { COMMENT_FILE, COMMENT_MARKER, renderComment, type CommentVideo } from "./comment.js";

/** The part of the GitHub client Publish uses. */
export type CommentClient = Pick<
  GitHubClient,
  "listIssueComments" | "createIssueComment" | "updateIssueComment"
>;

/** Options for {@link runPublish}. */
export interface RunPublishOptions {
  runDir: string;
  /** Where the workflow uploaded `final.mp4`. */
  videoUrl?: string;
  /** Post to the pull request. False renders `comment.md` only, which is all `spr run` does. */
  post: boolean;
  /** Needed only to post; undefined means there is no token. */
  github?: CommentClient;
}

/** What happened to the comment on GitHub. */
export interface Posted {
  /** `replaced`: the earlier comment could not be updated, so a new one was posted. */
  action: "created" | "updated" | "replaced";
  url: string;
}

/** What {@link runPublish} did. */
export interface PublishOutcome {
  file: string;
  findings: number;
  video: "linked" | "not uploaded" | "none";
  /** A URL was given for a review that has no video of its own, so it was left out. */
  ignoredUrl: boolean;
  posted: Posted | null;
}

/**
 * True for a URL that can go into a markdown link as it is: https, and none of the characters
 * that would end the link or open a tag.
 */
export function isVideoUrl(value: string): boolean {
  if (/[\s()<>]/.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Finds the comment an earlier run posted - the newest whose body *starts* with the marker, so a
 * person quoting it is never matched - and updates it, or posts one when there is none. An update
 * GitHub refuses (the comment was deleted, or belongs to an account this token is not) becomes a
 * new comment rather than a failure; a rate limit does not, since a second request would meet
 * the same limit.
 * @throws GitHubError
 */
export async function upsertComment(
  github: CommentClient,
  repo: string,
  pr: number,
  body: string,
): Promise<Posted> {
  const comments = await github.listIssueComments(repo, pr);
  const ours = comments.filter((c) => c.body.startsWith(COMMENT_MARKER)).at(-1);
  if (ours === undefined) {
    const created = await github.createIssueComment(repo, pr, body);
    return { action: "created", url: created.htmlUrl };
  }
  try {
    const updated = await github.updateIssueComment(repo, ours.id, body);
    return { action: "updated", url: updated.htmlUrl };
  } catch (error) {
    const refused =
      error instanceof GitHubError &&
      !error.rateLimited &&
      (error.status === 403 || error.status === 404);
    if (!refused) throw error;
    const created = await github.createIssueComment(repo, pr, body);
    return { action: "replaced", url: created.htmlUrl };
  }
}

/** The video this review has, if it has one: findings to explain, and a composed file. */
function videoOf(runDir: string, findings: number, url: string | undefined): CommentVideo | null {
  if (findings === 0) return null;
  if (!existsSync(path.join(runDir, FINAL_FILE)) || !existsSync(path.join(runDir, TIMELINE_FILE))) {
    return null;
  }
  return { durationMs: readTimeline(runDir).total_duration_ms, url: url ?? null };
}

/**
 * Renders `comment.md` from the run folder, and posts it when asked.
 * @throws StageError when posting was asked for and cannot happen, naming the file to use instead.
 */
export async function runPublish(options: RunPublishOptions): Promise<PublishOutcome> {
  const { runDir, videoUrl, post, github } = options;
  if (videoUrl !== undefined && !isVideoUrl(videoUrl)) {
    throw new StageError("publish", `Expected an https URL for the video, got "${videoUrl}"`);
  }

  const review = readReview(runDir);
  const ingest = readIngest(runDir);
  const video = videoOf(runDir, review.findings.length, videoUrl);
  const renamedFrom = Object.fromEntries(
    ingest.files.flatMap((f) =>
      f.old_path === null || f.old_path === f.path ? [] : [[f.path, f.old_path]],
    ),
  );

  const body = renderComment({ review, truncated: ingest.diff.truncated, renamedFrom, video });
  const file = path.join(runDir, COMMENT_FILE);
  writeFileSync(file, body, "utf8");

  const outcome: PublishOutcome = {
    file,
    findings: review.findings.length,
    video: video === null ? "none" : video.url === null ? "not uploaded" : "linked",
    ignoredUrl: videoUrl !== undefined && video === null,
    posted: null,
  };
  if (!post) return outcome;

  const { type, repo, pr_number: pr } = review.source;
  if (
    type !== "pull_request" ||
    repo === null ||
    repo === undefined ||
    pr === null ||
    pr === undefined
  ) {
    throw new StageError(
      "publish",
      `This run reviewed a ${type.replace("_", " ")}, not a pull request, so there is nothing to ` +
        `post to. The comment is in ${file}.`,
    );
  }
  if (github === undefined) {
    throw new StageError(
      "publish",
      `Posting needs GITHUB_TOKEN with pull-requests: write. The comment is in ${file}.`,
    );
  }
  try {
    return { ...outcome, posted: await upsertComment(github, repo, pr, body) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new StageError("publish", `${message} The comment is in ${file}.`, { cause });
  }
}

/** One or two lines for the CLI. */
export function summarizePublish(outcome: PublishOutcome): string {
  const findings = `${String(outcome.findings)} finding${outcome.findings === 1 ? "" : "s"}`;
  const video =
    outcome.video === "linked"
      ? ", video linked"
      : outcome.video === "not uploaded"
        ? ", video not linked (no --video-url)"
        : "";
  const lines = [`comment: ${outcome.file} (${findings}${video})`];
  if (outcome.ignoredUrl) lines.push("--video-url ignored: this review has no video of its own");
  if (outcome.posted !== null) lines.push(`posted: ${outcome.posted.action} ${outcome.posted.url}`);
  return lines.join("\n");
}
