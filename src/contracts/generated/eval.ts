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
   * `totals` partitioned into real and anonymized changes versus hand-written ones, with an entry only for an origin the set actually contains. A synthetic sample measures whether the model recognises a bug somebody wrote for it to find, which is a weaker claim than finding one that reached production, and the two must not be averaged into a single number that reads like the stronger claim.
   *
   * @maxItems 2
   */
  by_origin?: OriginTotals[];
  /**
   * Why this model could not be scored in full. Its totals then cover only the samples that ran, and are not comparable with a complete row. One model breaking must not discard the others' measurements.
   */
  failed?: string | null;
}
export interface SampleResult {
  sample: string;
  /**
   * Copied from the sample's labels.json, so a report can be read years later without the golden set beside it.
   */
  origin: "real" | "synthetic";
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
   * The share of matched findings whose severity sits inside its label's band. A separate axis from precision and recall, in the shape within_budget gave restraint: a finding at the right lines with the right category and the wrong severity has spotted the issue and misjudged it. Null when no matched label carries a band, so a set that has not been banded yet reports nothing rather than a flattering 1.
   */
  calibrated?: number | null;
  /**
   * The matched findings that fell outside their band, named. Direction matters more than count: over-rating and under-rating call for opposite corrections, and until this axis existed only under-rating was visible at all, as a recall gap.
   */
  miscalibrated?: Miscalibration[];
  /**
   * Labels that more than one kept finding located. Every such finding can be true and there can still be one too many of them - ADR-029's video described two problems in three steps, and precision and recall both read 1.000. A separate axis from precision, like within_budget and calibrated.
   */
  redundant?: Redundancy[];
  /**
   * How many matched findings had a band to be scored against, which is `calibrated`'s denominator. Reported rather than left to be recovered from the rounded rate, so totals across samples add up exactly.
   */
  calibration_scored?: number;
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
  /**
   * A label this finding sits on - same file, overlapping lines - under a category the label does not accept, preferring must_find labels. Attribution only, like must_not_flag_key: the finding stays a false positive, because the category is part of what says which issue a finding is about, and a finding at the right place under another heading may be the right bug misfiled or a different claim altogether. Null when a must_not_flag entry already names the mistake, or nothing is there.
   */
  near_miss_key?: string | null;
}
export interface Miscalibration {
  key: string;
  finding_id: string;
  severity: Severity;
  max_severity: Severity;
  min_severity: Severity;
  /**
   * Over: rated more serious than the band's ceiling. Under: less serious than its floor - which for a must_find label also costs recall, so it is already visible there.
   */
  direction: "over" | "under";
}
export interface Redundancy {
  key: string;
  /**
   * @minItems 2
   */
  finding_ids: string[];
}
export interface ScriptResult {
  /**
   * False when the Narrate stage failed. That is a result, not an error: the sample keeps its review score and the run continues. Null when the verified review kept no findings, so there was nothing to narrate: making no script is the correct outcome for a clean review (ADR-042), and on a restraint sample often the best one, so it is neither a script made nor one that failed.
   */
  narrated: boolean | null;
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
  /**
   * Matched findings inside their band, over every sample that had one. Null when no sample did.
   */
  calibrated?: number | null;
  /**
   * How many matched findings fell outside their band, over every sample.
   */
  miscalibrated?: number;
  /**
   * How many kept findings were surplus: for a label located three times, two.
   */
  redundant?: number;
  seconds: number;
  /**
   * How many samples the Narrate stage produced a script for.
   */
  narrated?: number;
  /**
   * How many samples kept at least one finding, and so had something to narrate: `narrated`'s denominator. A sample that kept nothing is left out rather than counted as a script that was not made, because making none is the correct outcome for it (ADR-042).
   */
  narratable?: number;
  /**
   * How many samples kept more findings than their max_findings allows.
   */
  over_budget?: number;
}
export interface OriginTotals {
  origin: "real" | "synthetic";
  /**
   * How many golden samples carry this origin. An origin with no samples has no entry at all, rather than an entry full of nulls.
   */
  samples: number;
  precision: number | null;
  recall: number | null;
  must_find: number;
  found: number;
  kept: number;
  false_positives?: number;
  calibrated?: number | null;
  miscalibrated?: number;
}
