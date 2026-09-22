/**
 * The Publish stage over a real run folder, with GitHub answered by a fake client: what it
 * renders, when it refuses to post, and how it finds the comment an earlier run posted.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AudioManifest } from "../../src/contracts/generated/audio-manifest.js";
import type { Source } from "../../src/contracts/generated/ingest.js";
import { runDirect, writeTimeline } from "../../src/director/direct.js";
import { buildIngest, writeIngest } from "../../src/ingest/ingest.js";
import { StageError } from "../../src/lib/errors.js";
import { GitHubError, type IssueComment } from "../../src/lib/github.js";
import { COMMENT_MARKER } from "../../src/publish/comment.js";
import {
  isVideoUrl,
  runPublish,
  summarizePublish,
  upsertComment,
  type CommentClient,
} from "../../src/publish/publish.js";
import { writeVerifiedReview } from "../../src/verify/verify.js";
import { defaultConfig, loadGolden, PR_BASE_SHA, PR_HEAD_SHA, readGoldenDiff } from "../helpers.js";

const SAMPLE = "sample-01-order-outbox";

const PR_SOURCE: Source = {
  type: "pull_request",
  repo: "acme/shop-platform",
  pr_number: 142,
  ref: "feature/place-order",
  base_sha: PR_BASE_SHA,
  head_sha: PR_HEAD_SHA,
  title: "Add PlaceOrder command handler",
};

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * A run folder as the pipeline leaves it: ingest and a verified review always, and a timeline
 * and `final.mp4` when the run went as far as a video.
 */
function runFolder(options: { source?: Source; clean?: boolean; video?: boolean } = {}): string {
  const { source = PR_SOURCE, clean = false, video = true } = options;
  const dir = mkdtempSync(path.join(tmpdir(), "spr-publish-"));
  temps.push(dir);
  const config = defaultConfig();
  const rawDiff = readGoldenDiff(SAMPLE);
  writeIngest(dir, rawDiff, buildIngest({ rawDiff, source, config }));

  const { review, script } = loadGolden(SAMPLE);
  writeVerifiedReview(dir, { ...review, source, ...(clean ? { findings: [] } : {}) });
  if (video) {
    const manifest: AudioManifest = {
      schema_version: "1.0",
      provider: "fake",
      voice: "af_heart",
      speed: 1,
      sample_rate: 24000,
      clips: script.steps.map((s) => ({
        step_id: s.id,
        path: `audio/${s.id}.wav`,
        duration_ms: 10_000,
        cache_key: "0".repeat(64),
        cached: false,
      })),
    };
    writeTimeline(dir, runDirect({ script, manifest, config }).timeline);
    writeFileSync(path.join(dir, "final.mp4"), "not really a video");
  }
  return dir;
}

function comment(id: number, body: string): IssueComment {
  return {
    id,
    body,
    htmlUrl: `https://github.com/acme/shop-platform/pull/142#issuecomment-${String(id)}`,
  };
}

/** A client that answers from a list of comments and records what was written. */
function fakeClient(
  existing: IssueComment[] = [],
  update: (id: number) => Promise<IssueComment> = (id) => Promise.resolve(comment(id, "")),
): { client: CommentClient; writes: string[] } {
  const writes: string[] = [];
  const client: CommentClient = {
    listIssueComments: () => Promise.resolve(existing),
    createIssueComment: (_repo, _pr, body) => {
      writes.push(`create ${String(body.length)}`);
      return Promise.resolve(comment(900, body));
    },
    updateIssueComment: (_repo, id, body) => {
      writes.push(`update ${String(id)} ${String(body.length)}`);
      return update(id);
    },
  };
  return { client, writes };
}

describe("runPublish", () => {
  it("renders comment.md and posts nothing when not asked to", async () => {
    const runDir = runFolder();
    const { client, writes } = fakeClient();
    const outcome = await runPublish({ runDir, post: false, github: client });

    const body = readFileSync(path.join(runDir, "comment.md"), "utf8");
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("The walkthrough (");
    expect(outcome).toMatchObject({ findings: 3, video: "not uploaded", posted: null });
    expect(writes).toEqual([]);
  });

  it("links the video when given its URL, and posts a new comment", async () => {
    const runDir = runFolder();
    const { client, writes } = fakeClient([comment(1, "LGTM")]);
    const outcome = await runPublish({
      runDir,
      post: true,
      github: client,
      videoUrl: "https://github.com/acme/shop-platform/actions/runs/7/artifacts/9",
    });

    expect(outcome.video).toBe("linked");
    expect(outcome.posted).toEqual({
      action: "created",
      url: "https://github.com/acme/shop-platform/pull/142#issuecomment-900",
    });
    expect(writes).toHaveLength(1);
    expect(summarizePublish(outcome)).toBe(
      `comment: ${path.join(runDir, "comment.md")} (3 findings, video linked)\n` +
        "posted: created https://github.com/acme/shop-platform/pull/142#issuecomment-900",
    );
  });

  it("leaves out a video URL for a review that has no video of its own", async () => {
    const runDir = runFolder({ clean: true });
    const outcome = await runPublish({
      runDir,
      post: false,
      videoUrl: "https://example.com/stale.mp4",
    });
    expect(outcome).toMatchObject({ findings: 0, video: "none", ignoredUrl: true });
    expect(readFileSync(outcome.file, "utf8")).not.toContain("stale.mp4");
  });

  it("says no video was made when a run with findings stopped before one", async () => {
    const outcome = await runPublish({ runDir: runFolder({ video: false }), post: false });
    expect(outcome.video).toBe("none");
    expect(readFileSync(outcome.file, "utf8")).toContain("No walkthrough video was made");
  });

  it("refuses to post a run that did not review a pull request, keeping comment.md", async () => {
    const local: Source = { ...PR_SOURCE, type: "local_diff", repo: null, pr_number: null };
    const runDir = runFolder({ source: local });
    const { client } = fakeClient();
    await expect(runPublish({ runDir, post: true, github: client })).rejects.toThrow(
      `This run reviewed a local diff, not a pull request, so there is nothing to post to. ` +
        `The comment is in ${path.join(runDir, "comment.md")}.`,
    );
    expect(existsSync(path.join(runDir, "comment.md"))).toBe(true);
  });

  it("refuses to post without a token, naming the permission", async () => {
    const runDir = runFolder();
    await expect(runPublish({ runDir, post: true })).rejects.toThrow(
      "Posting needs GITHUB_TOKEN with pull-requests: write.",
    );
  });

  it("fails as a publish error that points at comment.md when GitHub refuses", async () => {
    const runDir = runFolder();
    const client: CommentClient = {
      ...fakeClient().client,
      listIssueComments: () =>
        Promise.reject(new GitHubError("GitHub rejected GITHUB_TOKEN.", 401)),
    };
    const error = await runPublish({ runDir, post: true, github: client }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageError);
    expect((error as StageError).stage).toBe("publish");
    expect((error as StageError).message).toBe(
      `GitHub rejected GITHUB_TOKEN. The comment is in ${path.join(runDir, "comment.md")}.`,
    );
  });

  it("refuses a video URL that could break out of its link", async () => {
    await expect(
      runPublish({ runDir: runFolder(), post: false, videoUrl: "https://x.example/a)b" }),
    ).rejects.toThrow("Expected an https URL for the video");
  });
});

describe("upsertComment", () => {
  it("updates the newest comment that starts with the marker", async () => {
    const { client, writes } = fakeClient([
      comment(1, `${COMMENT_MARKER}\nold`),
      comment(2, `quoting you: ${COMMENT_MARKER}`),
      comment(3, `${COMMENT_MARKER}\nnewer`),
      comment(4, "thanks"),
    ]);
    const posted = await upsertComment(client, "acme/shop-platform", 142, "body");
    expect(posted.action).toBe("updated");
    expect(writes).toEqual(["update 3 4"]);
  });

  it("never mistakes a quoted marker for its own comment", async () => {
    const { client, writes } = fakeClient([comment(2, `> ${COMMENT_MARKER}`)]);
    expect((await upsertComment(client, "acme/shop-platform", 142, "body")).action).toBe("created");
    expect(writes).toEqual(["create 4"]);
  });

  it("posts a new comment when the old one cannot be updated", async () => {
    const { client, writes } = fakeClient([comment(3, `${COMMENT_MARKER}\nx`)], () =>
      Promise.reject(new GitHubError("GitHub refused to write comment 3.", 403)),
    );
    expect((await upsertComment(client, "acme/shop-platform", 142, "body")).action).toBe(
      "replaced",
    );
    expect(writes).toEqual(["update 3 4", "create 4"]);
  });

  it("does not try again past a rate limit", async () => {
    const limited = new GitHubError("GitHub's rate limit is used up.", 403, { rateLimited: true });
    const { client, writes } = fakeClient([comment(3, `${COMMENT_MARKER}\nx`)], () =>
      Promise.reject(limited),
    );
    await expect(upsertComment(client, "acme/shop-platform", 142, "body")).rejects.toBe(limited);
    expect(writes).toEqual(["update 3 4"]);
  });
});

describe("isVideoUrl", () => {
  it.each([
    ["https://github.com/acme/shop/actions/runs/1/artifacts/2", true],
    ["http://github.com/x", false],
    ["javascript:alert(1)", false],
    ["https://x.example/a b", false],
    ["https://x.example/<b>", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isVideoUrl(url)).toBe(expected);
  });
});
