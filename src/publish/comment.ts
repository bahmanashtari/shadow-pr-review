/**
 * The sticky pull request comment, rendered from a verified review (ADR-052). Pure: no I/O, so
 * every rule here - above all the sanitising - is unit-tested on its own, like the Director.
 *
 * The findings' text is untrusted. It is model output written after reading a diff that anyone
 * opening a pull request controls (ADR-049), and it is about to be posted under the team's
 * name. So outside code spans nothing in it can mention a person, render HTML, load an image,
 * link somewhere, or forge the marker that makes a comment ours.
 */
import type { Finding, ReviewResult, Severity } from "../contracts/generated/review.js";
import { isRepoName } from "../lib/github.js";

/** First line of every comment this tool posts; how the next run finds it again. */
export const COMMENT_MARKER = "<!-- shadow-pr-review -->";

/** Where the rendered comment is written in the run folder. */
export const COMMENT_FILE = "comment.md";

/** Well under GitHub's limit on a comment body (65,536 characters, observed; not documented). */
export const MAX_COMMENT_CHARS = 60_000;

/** The video, when this review has one. */
export interface CommentVideo {
  durationMs: number;
  /** Where it was uploaded; null when it is only in the run folder. */
  url: string | null;
}

/** Everything the comment is rendered from. */
export interface CommentInput {
  review: ReviewResult;
  /** Ingest cut the diff down to its riskiest files (`ingest.json` `diff.truncated`). */
  truncated: boolean;
  /** Old paths of renamed files, so a finding on removed lines links to the right file. */
  renamedFrom?: Readonly<Record<string, string>>;
  video: CommentVideo | null;
}

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

/** A zero-width space: after `@` it stops a mention without changing what a reader sees. */
const ZWSP = "\u200b";

/**
 * Splits text into code spans and the rest, erring towards "the rest": a span counts only if it
 * opens and closes with equal backtick runs on one line, since a span GitHub would not see - one
 * broken by a line that starts an HTML block, say - must never be left unescaped. Text with an
 * escaped backtick is all "the rest", because the escape changes where GitHub's spans fall.
 */
function splitCodeSpans(text: string): { code: boolean; text: string }[] {
  if (text.includes("\\`")) return [{ code: false, text }];
  const parts: { code: boolean; text: string }[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let open = i;
    while (text[open] === "`") open += 1;
    const run = open - i;
    let close = -1;
    for (let k = open; k < text.length && text[k] !== "\n";) {
      if (text[k] !== "`") {
        k += 1;
        continue;
      }
      let end = k;
      while (text[end] === "`") end += 1;
      if (end - k === run) {
        close = end;
        break;
      }
      k = end;
    }
    if (close === -1) {
      i = open;
      continue;
    }
    if (plainStart < i) parts.push({ code: false, text: text.slice(plainStart, i) });
    parts.push({ code: true, text: text.slice(i, close) });
    i = close;
    plainStart = close;
  }
  if (plainStart < text.length) parts.push({ code: false, text: text.slice(plainStart) });
  return parts;
}

/**
 * Makes untrusted text inert in GitHub markdown, leaving code spans as they are (GitHub neither
 * mentions nor renders HTML inside them). Outside them: `@name` cannot mention, `<` and `>`
 * cannot open a tag or a comment, and `[` and `]` cannot start a link or an image.
 */
export function inertText(text: string): string {
  return splitCodeSpans(text)
    .map((part) =>
      part.code
        ? part.text
        : part.text
            .replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWSP}`)
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/([[\]])/g, "\\$1"),
    )
    .join("");
}

/** Inert text for one table cell: no line breaks, no column separators. */
function cell(text: string): string {
  return inertText(text.replace(/\s*\n\s*/g, " ")).replace(/\|/g, "\\|");
}

/** `42000` -> `0:42`. */
function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/** `#L6` or `#L19-L27`. */
function lineAnchor(finding: Finding): string {
  return finding.line_end === finding.line_start
    ? `#L${String(finding.line_start)}`
    : `#L${String(finding.line_start)}-L${String(finding.line_end)}`;
}

/**
 * A link that keeps pointing at the reviewed lines after the next push: the head commit for
 * added lines, the base commit (and the old path of a renamed file) for removed ones. Null when
 * the run did not come from GitHub.
 */
function permalink(review: ReviewResult, finding: Finding, input: CommentInput): string | null {
  const { repo, head_sha: head, base_sha: base } = review.source;
  if (repo === null || repo === undefined || !isRepoName(repo)) return null;
  const sha = finding.side === "new" ? head : base;
  if (sha === null || sha === undefined) return null;
  const file =
    finding.side === "old" ? (input.renamedFrom?.[finding.file] ?? finding.file) : finding.file;
  // encodeURIComponent leaves ( and ) alone, and either would end the markdown link early.
  const encoded = file
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29")))
    .join("/");
  return `https://github.com/${repo}/blob/${sha}/${encoded}${lineAnchor(finding)}`;
}

/** `1 high, 2 low`, most severe first. */
function severityCounts(findings: readonly Finding[]): string {
  return SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${String(n)} ${s}`)
    .join(", ");
}

/** The line under the heading: what was found, on which commit, and where the video is. */
function statusLine(input: CommentInput): string {
  const { findings, source } = input.review;
  const sha = source.head_sha;
  const on = sha === null || sha === undefined ? "" : ` on \`${sha.slice(0, 7)}\``;
  if (findings.length === 0) return `**No findings**${on}.`;

  const count = `**${String(findings.length)} finding${findings.length === 1 ? "" : "s"}**`;
  const head = `${count}${on}: ${severityCounts(findings)}.`;
  const { video } = input;
  if (video === null) return `${head} No walkthrough video was made for this run.`;
  const length = clock(video.durationMs);
  return video.url === null
    ? `${head} The walkthrough (${length}) was not uploaded; it is \`final.mp4\` in the run folder.`
    : `${head} [Watch the walkthrough](${video.url}) (${length}).`;
}

/** Which files were looked at, and what was left out and why. */
function coverageLine(input: CommentInput): string {
  const reviewed = input.review.stats?.files_reviewed ?? 0;
  const skipped = input.review.stats?.files_skipped ?? [];
  const files = `${String(reviewed)} file${reviewed === 1 ? "" : "s"}`;
  const reasons = [...new Set(skipped.map((s) => s.reason.replace(/_/g, " ")))].join(", ");
  const left = skipped.length === 0 ? "" : `; ${String(skipped.length)} skipped (${reasons})`;
  const cut = input.truncated
    ? " The diff was over the size limit, so only its riskiest files were reviewed."
    : "";
  return `Reviewed ${files}${left}.${cut}`;
}

/** One finding's collapsed section: where, why, and what to do about it. */
function details(finding: Finding): string {
  const lines =
    finding.line_end === finding.line_start
      ? `line ${String(finding.line_start)}`
      : `lines ${String(finding.line_start)}-${String(finding.line_end)}`;
  const side = finding.side === "old" ? ", removed" : "";
  const was = finding.verification?.original_severity;
  const downgraded =
    finding.verification?.status === "downgraded" && was !== undefined
      ? ` Downgraded from ${was} on review.`
      : "";
  return [
    `<details><summary>${finding.severity} · ${cell(finding.summary)}</summary>`,
    "",
    `\`${finding.file.replace(/`/g, "'")}\`, ${lines}${side}.${downgraded}`,
    "",
    inertText(finding.rationale),
    "",
    `**Suggested fix:** ${inertText(finding.suggestion)}`,
    "",
    "</details>",
  ].join("\n");
}

/**
 * Renders the whole comment. The review's own `summary` is left out on purpose: it is prose that
 * has asserted a severity the `severity` field did not (ADR-038), and the table says the same
 * thing from the fields.
 */
export function renderComment(input: CommentInput): string {
  const { review } = input;
  const parts = [
    COMMENT_MARKER,
    "### shadow-pr-review",
    "",
    statusLine(input),
    "",
    coverageLine(input),
  ];

  if (review.findings.length > 0) {
    parts.push("", "| Severity | Where | Finding |", "|---|---|---|");
    for (const finding of review.findings) {
      const name = finding.file.split("/").pop() ?? finding.file;
      const label = cell(`${name}${lineAnchor(finding)}`);
      const link = permalink(review, finding, input);
      const where = link === null ? label : `[${label}](${link})`;
      parts.push(`| ${finding.severity} | ${where} | ${cell(finding.summary)} |`);
    }
    for (const finding of review.findings) parts.push("", details(finding));
  }

  const body = `${parts.join("\n")}\n`;
  if (body.length <= MAX_COMMENT_CHARS) return body;
  const note = "\n\n(Cut to fit a GitHub comment; `review.json` has the rest.)\n";
  return body.slice(0, MAX_COMMENT_CHARS - note.length) + note;
}
