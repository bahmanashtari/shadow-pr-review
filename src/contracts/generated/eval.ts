/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/eval.schema.json. Regenerate with `pnpm gen:types`.
 */

export type Severity = "critical" | "high" | "medium" | "low";

/**
 * Contract for eval.json, written by `spr eval`. A report rather than a stage contract: nothing downstream reads it, and it exists so a prompt or model change can be argued about with numbers. One entry in `models` per model scored, each holding one entry per golden sample plus micro-averaged totals.
 */
export interface EvalReport {
  schema_version: "1.0";
  /**
   * UTC ISO-8601 timestamp, so two reports pasted side by side can be dated.
   */
  generated_at: string;
  golden_dir: string;
  /**
   * @minItems 1
   */
  models: ModelRun[];
}
export interface ModelRun {
  provider: string;
  model: string;
  samples: SampleResult[];
  totals: Totals;
  /**
   * Why this model could not be scored in full. Its totals then cover only the samples that ran, and are not comparable with a complete row. One model breaking must not discard the others' measurements.
   */
  failed?: string | null;
}
export interface SampleResult {
  sample: string;
  run_dir: string;
  /**
   * True when every model call for this sample was served from the on-disk cache (ADR-017), so the row measures a past answer rather than a fresh one.
   */
  cached: boolean;
  seconds?: number;
  /**
   * Why the Reviewer stopped early, for example budget:agentSteps. Null when it answered.
   */
  stopped?: string | null;
  review: ReviewScore;
  script: ScriptResult;
}
export interface ReviewScore {
  kept: number;
  /**
   * The sample's restraint budget from labels.json, or null when it sets none.
   */
  max_findings?: number | null;
  /**
   * Whether kept findings fit max_findings. A separate axis from precision: every finding can be defensible and there can still be too many of them. True when the sample sets no budget.
   */
  within_budget: boolean;
  /**
   * Null when the Reviewer kept nothing, which is correct rather than perfect: precision over an empty set is undefined.
   */
  precision: number | null;
  /**
   * Null when the sample has no must_find labels. Such a sample tests restraint, so a recall of 1 would flatter it and a recall of 0 would libel it.
   */
  recall: number | null;
  /**
   * must_find labels a kept finding matched.
   */
  found: Match[];
  /**
   * Keys of must_find labels nothing matched.
   */
  missed: string[];
  /**
   * Optional issues the run spotted. These never affect precision or recall - they are already true positives and are not required - but they are the only place a run that says something real and a run that says nothing look different.
   */
  acceptable_found: Match[];
  false_positives: FalsePositive[];
  /**
   * What the Verifier removed, by reason. Not a score: a finding dropped before the viewer saw it is not a false positive, but the reason says whether the model is producing bad claims or good claims it cannot quote.
   */
  dropped: {
    reason: string;
    count: number;
  }[];
}
export interface Match {
  key: string;
  finding_id: string;
  severity?: Severity;
}
export interface FalsePositive {
  finding_id: string;
  file: string;
  line_start: number;
  line_end: number;
  category: string;
  severity?: Severity;
  summary: string;
  /**
   * The must_not_flag label this finding appears to be, when one names it. Null means the model invented a mistake the set does not know about yet, which is worth reading.
   */
  must_not_flag_key?: string | null;
}
export interface ScriptResult {
  /**
   * False when the Narrate stage failed. That is a result, not an error: the sample keeps its review score and the run continues.
   */
  narrated: boolean;
  failure?: string | null;
  steps?: number;
  words?: number;
  max_step_words?: number;
  estimated_seconds?: number;
  expected_steps?: number;
  expected_seconds?: number;
}
export interface Totals {
  precision: number | null;
  recall: number | null;
  must_find: number;
  found: number;
  acceptable?: number;
  acceptable_found?: number;
  kept: number;
  false_positives: number;
  seconds: number;
  narrated?: number;
  /**
   * How many samples kept more findings than their max_findings allows.
   */
  over_budget?: number;
}
