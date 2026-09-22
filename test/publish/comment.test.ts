/**
 * The sticky comment, rendered from the golden reviews and from hostile ones. No I/O: the
 * renderer is pure, and the sanitising is the part that has to be trusted.
 */
import { describe, expect, it } from "vitest";
import type { Finding, ReviewResult } from "../../src/contracts/generated/review.js";
import {
  COMMENT_MARKER,
  inertText,
  MAX_COMMENT_CHARS,
  renderComment,
  type CommentInput,
} from "../../src/publish/comment.js";
import { loadGolden, PR_BASE_SHA, PR_HEAD_SHA } from "../helpers.js";

/** sample-01's expected review, as if it came from pull request acme/shop-platform#142. */
function review(over: Partial<ReviewResult> = {}): ReviewResult {
  const { review: golden } = loadGolden("sample-01-order-outbox");
  return {
    ...golden,
    source: { ...golden.source, base_sha: PR_BASE_SHA, head_sha: PR_HEAD_SHA },
    ...over,
  };
}

function input(over: Partial<CommentInput> = {}): CommentInput {
  return {
    review: review(),
    truncated: false,
    video: { durationMs: 42_400, url: "https://github.com/acme/shop-platform/actions/runs/1" },
    ...over,
  };
}

/** A finding with hostile text in every field a model writes. */
function hostile(text: string): Finding {
  const [first] = review().findings;
  if (first === undefined) throw new Error("sample-01 has findings");
  return { ...first, summary: text, rationale: text, suggestion: text };
}

describe("renderComment", () => {
  it("opens with the marker and says what was found, on which commit, with the video", () => {
    const body = renderComment(input());
    const lines = body.split("\n");
    expect(lines[0]).toBe(COMMENT_MARKER);
    expect(lines[3]).toBe(
      "**3 findings** on `aaaaaaa`: 1 high, 1 medium, 1 low. " +
        "[Watch the walkthrough](https://github.com/acme/shop-platform/actions/runs/1) (0:42).",
    );
    expect(lines[5]).toBe("Reviewed 1 file.");
  });

  it("puts every finding in a table row with a permalink at the head, and in a section", () => {
    const body = renderComment(input());
    const [first] = review().findings;
    if (first === undefined) throw new Error("sample-01 has findings");
    const link =
      `https://github.com/acme/shop-platform/blob/${PR_HEAD_SHA}/${first.file}` +
      `#L${String(first.line_start)}-L${String(first.line_end)}`;
    expect(body).toContain(`| high | [place-order.handler.ts#L${String(first.line_start)}-L`);
    expect(body).toContain(`](${link}) |`);
    expect(body).toContain(`<details><summary>high · ${first.summary}</summary>`);
    expect(body).toContain(`**Suggested fix:** `);
    expect(body.match(/<details>/g)).toHaveLength(3);
  });

  it("links removed lines at the base commit, under a renamed file's old path", () => {
    const [first] = review().findings;
    if (first === undefined) throw new Error("sample-01 has findings");
    const old: Finding = { ...first, side: "old", line_start: 4, line_end: 4 };
    const body = renderComment(
      input({
        review: review({ findings: [old] }),
        renamedFrom: { [first.file]: "src/old name (v1).ts" },
      }),
    );
    expect(body).toContain(
      `(https://github.com/acme/shop-platform/blob/${PR_BASE_SHA}/src/old%20name%20%28v1%29.ts#L4)`,
    );
    expect(body).toContain("line 4, removed.");
  });

  it("does not link when the run did not come from GitHub", () => {
    const local = review();
    const body = renderComment(
      input({ review: { ...local, source: { ...local.source, repo: null, head_sha: null } } }),
    );
    expect(body).not.toContain("/blob/");
    expect(body).toContain("| high | place-order.handler.ts#L19-L27 |");
    expect(body).toContain("**3 findings**: 1 high");
  });

  it("says a clean review in one line, with no table and no video", () => {
    const body = renderComment(input({ review: review({ findings: [] }), video: null }));
    expect(body).toBe(
      `${COMMENT_MARKER}\n### shadow-pr-review\n\n**No findings** on \`aaaaaaa\`.\n\n` +
        "Reviewed 1 file.\n",
    );
  });

  it("says where the video is when it was not uploaded, and when there is none", () => {
    expect(renderComment(input({ video: { durationMs: 42_400, url: null } }))).toContain(
      "The walkthrough (0:42) was not uploaded; it is `final.mp4` in the run folder.",
    );
    expect(renderComment(input({ video: null }))).toContain(
      "No walkthrough video was made for this run.",
    );
  });

  it("says what was skipped, and when the diff was cut to its riskiest files", () => {
    const body = renderComment(
      input({
        truncated: true,
        review: review({
          stats: {
            files_reviewed: 4,
            files_skipped: [
              { file: "pnpm-lock.yaml", reason: "lockfile" },
              { file: "big.ts", reason: "too_large" },
              { file: "huge.ts", reason: "too_large" },
            ],
          },
        }),
      }),
    );
    expect(body).toContain(
      "Reviewed 4 files; 3 skipped (lockfile, too large). The diff was over the size limit, " +
        "so only its riskiest files were reviewed.",
    );
  });

  it("says a downgrade, with the severity the Reviewer gave", () => {
    const [first] = review().findings;
    if (first === undefined) throw new Error("sample-01 has findings");
    const downgraded: Finding = {
      ...first,
      severity: "low",
      verification: { status: "downgraded", original_severity: "critical" },
    };
    expect(renderComment(input({ review: review({ findings: [downgraded] }) }))).toContain(
      "Downgraded from critical on review.",
    );
  });

  it("cannot be made to mention, render HTML, link, or forge the marker", () => {
    const attack =
      "@octocat look <img src=https://evil.example/x.png> ![p](https://evil.example/p.png) " +
      "[click](https://evil.example) <!-- shadow-pr-review --> </details>";
    const body = renderComment(input({ review: review({ findings: [hostile(attack)] }) }));

    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    const rest = body.slice(COMMENT_MARKER.length);
    expect(rest).not.toContain("<!--");
    expect(rest).not.toContain("<img");
    expect(rest).not.toMatch(/@octocat/);
    expect(rest).not.toMatch(/!\[p\]|[^\\]\[click\]/);
    expect(rest.match(/<\/details>/g)).toHaveLength(1);
  });

  it("keeps a table row one row, whatever the summary holds", () => {
    const body = renderComment(
      input({ review: review({ findings: [hostile("a | b\n| c | d |")] }) }),
    );
    const lines = body.split("\n");
    const start = lines.indexOf("| Severity | Where | Finding |");
    const rows = lines.slice(start, lines.indexOf("", start));
    expect(rows).toHaveLength(3); // header, delimiter, and the one finding
    expect(rows[2]?.endsWith(" | a \\| b \\| c \\| d \\| |")).toBe(true);
  });

  it("is cut to fit a GitHub comment, saying so", () => {
    const long = "x".repeat(1200);
    const many = Array.from({ length: 60 }, () => hostile(long));
    const body = renderComment(input({ review: review({ findings: many }) }));
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(body).toMatch(/Cut to fit a GitHub comment; `review.json` has the rest.\)\n$/);
  });
});

describe("inertText", () => {
  it("leaves code spans alone and makes everything else inert", () => {
    expect(inertText("`Promise<void>` and @Injectable in `@Injectable()`")).toBe(
      "`Promise<void>` and @\u200bInjectable in `@Injectable()`",
    );
    expect(inertText("see [docs](https://x.example) <b>")).toBe(
      "see \\[docs\\](https://x.example) &lt;b&gt;",
    );
  });

  it("treats a span GitHub would not see as text: unclosed, uneven, escaped or across lines", () => {
    expect(inertText("``<img src=x>`")).toBe("``&lt;img src=x&gt;`");
    expect(inertText("\\`<img src=x>`")).toBe("\\`&lt;img src=x&gt;`");
    expect(inertText("`a\n<div>b`")).toBe("`a\n&lt;div&gt;b`");
  });

  it("leaves an email address readable but unmentionable", () => {
    expect(inertText("mail a@b.example")).toBe("mail a@\u200bb.example");
  });
});
