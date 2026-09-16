/**
 * The deterministic half of the Verifier: everything that can be proved from `ingest.json`.
 *
 * CLAUDE.md principle 5 says a finding must point at real lines and quote them verbatim, and
 * that what cannot be verified is dropped rather than narrated. This is where that happens.
 * Pure functions over a `HunkIndex`: no model, no I/O, no configuration beyond the cap.
 */
import { compareFindings, SEVERITY_RANK } from "../contracts/checks.js";
import type { DroppedFinding, Finding } from "../contracts/generated/review.js";
import type { HunkIndex } from "../ingest/hunk-index.js";

/** Why a finding did not survive. The values the review contract allows. */
export type DropReason = DroppedFinding["reason"];

/** A failed check: the reason for the contract, and a note a human can act on. */
export interface Rejection {
  reason: DropReason;
  note: string;
}

/** A finding that did not survive, with the reason it did not. */
export interface Dropped {
  finding: Finding;
  rejection: Rejection;
}

/** What {@link screenFindings} decided. */
export interface Screening {
  kept: Finding[];
  dropped: Dropped[];
}

/** `note` is capped at 500 characters by the schema; quoted code is what gets cut. */
function quote(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? `"${flat}"` : `"${flat.slice(0, max - 1)}…"`;
}

/**
 * Checks one finding against the diff it claims to describe.
 * Returns null when the finding is grounded, or the first failure otherwise.
 *
 * The order is deliberate: a file that is not in the diff has no lines to check, and a
 * finding whose lines do not exist cannot be quoted from them.
 */
export function checkGrounded(index: HunkIndex, finding: Finding): Rejection | null {
  if (!index.hasFile(finding.file)) {
    return {
      reason: "out_of_scope",
      // Reachable through `read_file` and `grep_repo`: a real problem in a file this change
      // never touched. Correct, and impossible to highlight in the video.
      note: `${finding.file} is not part of the reviewed diff`,
    };
  }

  if (!index.hasRange(finding.file, finding.side, finding.line_start, finding.line_end)) {
    return {
      reason: "lines_not_in_diff",
      note:
        `${finding.side} lines ${finding.line_start}-${finding.line_end} are not all in the ` +
        `diff for this file`,
    };
  }

  const total = finding.evidence.length;
  for (const [i, snippet] of finding.evidence.entries()) {
    if (!index.containsSnippet(finding.file, snippet)) {
      return {
        reason: "claim_not_supported",
        note: `evidence ${i + 1} of ${total} does not appear in the diff: ${quote(snippet)}`,
      };
    }
  }

  return null;
}

/**
 * True when two findings make the same claim: same file, same category, and ranges that
 * overlap. Different categories on the same lines are not duplicates - `sample-01` reports an
 * event-consistency bug and a layering problem on the same two lines, and both are real.
 */
export function sameClaim(a: Finding, b: Finding): boolean {
  return (
    a.file === b.file &&
    a.category === b.category &&
    a.line_start <= b.line_end &&
    b.line_start <= a.line_end
  );
}

/** Which of two duplicates to keep: severity, then confidence, then the earlier id. */
function byStrength(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Input for {@link screenFindings}. */
export interface ScreenOptions {
  index: HunkIndex;
  findings: readonly Finding[];
  /** `config.review.maxFindings`; everything past it is dropped as `over_cap`. */
  maxFindings: number;
}

/**
 * Runs the full gauntlet: grounding, then duplicates, then the cap.
 *
 * Each stage feeds the next, which is why they are not independent filters. An ungrounded
 * finding must not shadow its grounded duplicate, and nothing should be cut for space until
 * everything unprovable is already gone.
 */
export function screenFindings(options: ScreenOptions): Screening {
  const { index, findings, maxFindings } = options;
  const dropped: Dropped[] = [];

  const grounded: Finding[] = [];
  for (const finding of findings) {
    const rejection = checkGrounded(index, finding);
    if (rejection) dropped.push({ finding, rejection });
    else grounded.push(finding);
  }

  const unique: Finding[] = [];
  for (const finding of [...grounded].sort(byStrength)) {
    const existing = unique.find((kept) => sameClaim(kept, finding));
    if (existing) {
      dropped.push({
        finding,
        rejection: {
          reason: "duplicate",
          note:
            `same claim as ${existing.id} (${existing.category}, lines ` +
            `${existing.line_start}-${existing.line_end})`,
        },
      });
    } else {
      unique.push(finding);
    }
  }

  const ordered = unique.sort(compareFindings);
  const kept = ordered.slice(0, maxFindings);
  for (const finding of ordered.slice(maxFindings)) {
    dropped.push({
      finding,
      rejection: {
        reason: "over_cap",
        note: `more than ${maxFindings} findings survived verification`,
      },
    });
  }

  // Sorted by id so the dropped list reads in the order the Reviewer produced them,
  // whichever check removed them.
  dropped.sort((a, b) => (a.finding.id < b.finding.id ? -1 : a.finding.id > b.finding.id ? 1 : 0));
  return { kept, dropped };
}
