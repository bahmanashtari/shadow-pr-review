/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/labels.schema.json. Regenerate with `pnpm gen:types`.
 */

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
 * Contract for golden/<sample>/labels.json: the hand-written ground truth `spr eval` scores against. `must_find` items drive recall, `must_find` and `acceptable` together drive precision, and `must_not_flag` names the mistakes this sample exists to catch. Code-level validators must additionally enforce: line_end >= line_start, keys are unique within a sample, and `sample` matches the folder name.
 */
export interface GoldenLabels {
  /**
   * The sample folder's name, for example sample-01-order-outbox.
   */
  sample: string;
  /**
   * Issues the Reviewer must report. An empty list is meaningful: the sample tests restraint, and its recall is undefined rather than zero.
   */
  must_find: RequiredLabel[];
  /**
   * Real issues that do not have to be found, but count as true positives when they are.
   */
  acceptable: AcceptableLabel[];
  /**
   * Known false positives. A location is optional and often impossible - some entries are about code that is absent - so these name a mistake rather than define one. A finding matching neither must_find nor acceptable is already a false positive by the precision rule; these only give it a name.
   */
  must_not_flag: ForbiddenLabel[];
  /**
   * The most kept findings a good run should produce on this sample. Restraint is a separate axis from precision: a run can be entirely defensible and still say too much.
   */
  max_findings?: number;
  /**
   * What this sample is for, in prose. Read by people, not scored.
   */
  notes?: string;
}
export interface RequiredLabel {
  /**
   * Stable identifier, unique within the sample. Scores are reported against it.
   */
  key: string;
  file: string;
  line_start: number;
  line_end: number;
  category: Category;
  /**
   * Other categories that still count as a match, for an issue a reasonable reviewer could file under more than one heading.
   */
  accept_categories?: Category[];
  /**
   * The lowest severity that still counts as finding this issue. Calibration is a known weak spot (ADR-015, ADR-018), so it is scored rather than assumed.
   */
  min_severity: "critical" | "high" | "medium" | "low";
  description: string;
}
export interface AcceptableLabel {
  key: string;
  file: string;
  line_start: number;
  line_end: number;
  category: Category;
  accept_categories?: Category[];
  description: string;
}
export interface ForbiddenLabel {
  key: string;
  /**
   * Where the mistake would be made, when it has a place at all. Only used to attribute a false positive to this key; it never decides whether one occurred.
   */
  file?: string;
  line_start?: number;
  line_end?: number;
  category?: Category;
  description: string;
}
