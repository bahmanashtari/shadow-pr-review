/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/ingest.schema.json. Regenerate with `pnpm gen:types`.
 */

export type Sha256 = string;
export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

/**
 * Contract for ingest.json. Produced by the Ingest stage (plain code, no LLM). Describes the source, which files were kept or skipped, and a line index of every kept hunk. Deterministic: the same input diff and config produce the same bytes (no timestamps). In the run folder, diff.raw.patch is the unfiltered input and diff.patch contains only the kept files. Code-level checks must additionally enforce: file paths are unique, hunk line counts match their lines, and line numbers increase within a hunk. $defs.Source must stay identical to $defs.Source in review.schema.json (a unit test enforces this); the Reviewer copies source into review.json.
 */
export interface IngestResult {
  schema_version: "1.0";
  source: Source;
  diff: {
    raw_path: "diff.raw.patch";
    raw_sha256: Sha256;
    raw_bytes: number;
    path: "diff.patch";
    sha256: Sha256;
    bytes: number;
    /**
     * True when kept-looking files were skipped because the total exceeded ingest.maxDiffBytes. The narration intro must say so.
     */
    truncated: boolean;
  };
  /**
   * Kept files, in the order they appear in the diff.
   */
  files: KeptFile[];
  /**
   * Files left out of diff.patch, in diff order.
   */
  skipped: SkippedFile[];
  stats: {
    files_total: number;
    files_kept: number;
    files_skipped: number;
    /**
     * Added lines in kept files.
     */
    additions: number;
    /**
     * Deleted lines in kept files.
     */
    deletions: number;
  };
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
export interface KeptFile {
  /**
   * Repo-relative path on the new side; for deleted files, the old path. This is the `file` used by findings and focus.
   */
  path: string;
  /**
   * Previous path for renamed or copied files; otherwise null.
   */
  old_path: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  /**
   * Heuristic priority used when the diff is over budget and to order files for the Reviewer. Higher is riskier.
   */
  risk_score: number;
  /**
   * May be empty (pure rename or mode change).
   */
  hunks: Hunk[];
}
export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  /**
   * Text after the closing @@ (often the enclosing function), trimmed; empty string when absent.
   */
  section: string;
  /**
   * @minItems 1
   */
  lines: Line[];
}
export interface Line {
  kind: "add" | "del" | "context";
  /**
   * Line number on the old side; null for added lines.
   */
  old: number | null;
  /**
   * Line number on the new side; null for deleted lines.
   */
  new: number | null;
  /**
   * Line content without the leading +, - or space marker and without the line ending (a trailing CR is removed).
   */
  text: string;
  /**
   * Present and true when the diff marks this line with 'No newline at end of file'.
   */
  no_newline_at_eof?: boolean;
}
export interface SkippedFile {
  file: string;
  status: FileStatus;
  reason: "lockfile" | "generated" | "binary" | "vendored" | "too_large" | "ignored_by_config";
}
