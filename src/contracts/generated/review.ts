/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/review.schema.json. Regenerate with `pnpm gen:types`.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type Category =
  | "correctness"
  | "security"
  | "privacy"
  | "event-consistency"
  | "idempotency"
  | "ddd-boundaries"
  | "data-migration"
  | "api-contract"
  | "concurrency"
  | "performance"
  | "error-handling"
  | "testing"
  | "maintainability";

/**
 * Contract for review.json. Produced by the Reviewer agent and finalized by the Verifier agent. Line numbers refer to the file version named by `side` (new = head, old = base). Code-level validators must additionally enforce: line_end >= line_start, finding ids are unique, and every (file, side, line range) exists in the ingested diff.
 */
export interface ReviewResult {
  schema_version: "1.0";
  source: Source;
  /**
   * Two or three sentences describing what the change does and its overall risk.
   */
  summary: string;
  /**
   * Kept findings, ordered by severity (critical first), then by file and line.
   *
   * @maxItems 10
   */
  findings: Finding[];
  /**
   * Findings removed by the Verifier. Kept for tracing and evals; never narrated.
   */
  dropped: DroppedFinding[];
  stats?: Stats;
}
export interface Source {
  type: "pull_request" | "push" | "local_diff";
  /**
   * owner/name
   */
  repo?: string | null;
  pr_number?: number | null;
  /**
   * Branch name for push events.
   */
  ref?: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
  title?: string | null;
}
export interface Finding {
  id: string;
  /**
   * Repo-relative path exactly as it appears in the diff.
   */
  file: string;
  side: "new" | "old";
  line_start: number;
  line_end: number;
  severity: Severity;
  category: Category;
  summary: string;
  /**
   * Why this is a problem, grounded in the quoted lines.
   */
  rationale: string;
  suggestion: string;
  confidence: number;
  /**
   * Short verbatim snippets from the diff that support the claim. The Verifier checks these exist.
   *
   * @maxItems 5
   */
  evidence?: string[];
  verification?: Verification;
}
export interface Verification {
  status: "verified" | "downgraded";
  original_severity?: Severity;
  note?: string;
}
export interface DroppedFinding {
  id: string;
  file: string;
  line_start?: number | null;
  line_end?: number | null;
  summary: string;
  reason:
    | "lines_not_in_diff"
    | "claim_not_supported"
    | "duplicate"
    | "out_of_scope"
    | "over_cap"
    | "style_only";
  note?: string;
}
export interface Stats {
  files_reviewed?: number;
  files_skipped?: {
    file: string;
    reason: "lockfile" | "generated" | "binary" | "vendored" | "too_large" | "ignored_by_config";
  }[];
}
