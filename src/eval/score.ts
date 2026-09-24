/**
 * Scoring for `spr eval`: labels plus a produced review and script become numbers.
 *
 * Pure, with no I/O and no model, because the arithmetic is the part that has to be trusted.
 * The matching rule is the one `golden/README.md` states, and ADR-025 records the two places
 * where it needed a ruling the README left open.
 */
import { SEVERITY_RANK, countWords } from "../contracts/checks.js";
import type {
  BudgetWarning,
  EvalReport,
  FalsePositive,
  Match,
  Miscalibration,
  ModelRun,
  OriginTotals,
  Range,
  Redundancy,
  ReviewScore,
  ScriptResult,
  SampleResult,
  Spread,
  Totals,
  UnstableLabel,
} from "../contracts/generated/eval.js";
import type {
  AcceptableLabel,
  ForbiddenLabel,
  GoldenLabels,
  RequiredLabel,
} from "../contracts/generated/labels.js";
import type { Finding, ReviewResult } from "../contracts/generated/review.js";
import type { NarrationScript } from "../contracts/generated/script.js";

/** A label that names a place in the diff: everything but `must_not_flag`. */
type PlacedLabel = RequiredLabel | AcceptableLabel;

/** Where a sample's change came from. Taken from the contract rather than restated here. */
type Origin = SampleResult["origin"];

/** Rates are reported to three decimals; more is noise in a report a person reads. */
function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Whether a finding is about the same thing as a label: same file, overlapping lines, and a
 * category the label accepts. Severity is deliberately not part of this - see {@link found}.
 */
export function locates(finding: Finding, label: PlacedLabel): boolean {
  if (finding.file !== label.file) return false;
  if (finding.line_start > label.line_end || label.line_start > finding.line_end) return false;
  const accepted: readonly string[] = [label.category, ...(label.accept_categories ?? [])];
  return accepted.includes(finding.category);
}

/**
 * Whether a finding actually counts as finding a required issue: it must also be rated at
 * least as serious as the label demands.
 *
 * Splitting this from {@link locates} is the ruling that matters. A finding that points at the
 * right lines with the right category but calls a `high` issue `medium` has spotted the
 * problem and misjudged it. Counting it as a false positive would be false - nothing spurious
 * was said - so it counts for precision and not for recall. Severity calibration is the known
 * weak spot (ADR-015, ADR-018), and this is what isolates it: a model that sees everything and
 * under-rates it scores precision 1 and recall below 1, which says precisely what is wrong.
 */
export function found(finding: Finding, label: RequiredLabel): boolean {
  return (
    locates(finding, label) && SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[label.min_severity]
  );
}

/**
 * Whether a finding's severity sits inside the band its label allows, and which way out it is.
 *
 * The axis ADR-025 left open. Its ruling - that a finding at the right lines with the right
 * category counts for precision whatever severity it carries - is right, and the asymmetry it
 * leaves is not: under-rating shows up as a recall gap through {@link found}, while over-rating
 * costs nothing anywhere. `sample-03` rated a `low` privacy issue `critical` and scored
 * 1.000/1.000 (ADR-036), and the over-rating reached the viewer as "a critical security issue"
 * in the narration and "1 critical" on the outro card.
 *
 * @returns `null` when the label carries no band, which is not a pass - such a label is left
 * out of the score entirely, so an unbanded set reports nothing rather than a flattering 1.
 */
export function calibration(finding: Finding, label: PlacedLabel): "over" | "under" | "in" | null {
  const { max_severity: ceiling, min_severity: floor } = label;
  if (ceiling === undefined || floor === undefined) return null;

  const rank = SEVERITY_RANK[finding.severity];
  // `critical` ranks 0, so the more serious end of the band is the lower number.
  if (rank < SEVERITY_RANK[ceiling]) return "over";
  if (rank > SEVERITY_RANK[floor]) return "under";
  return "in";
}

/** The `must_not_flag` entry a false positive appears to be, when one names its place. */
function nameFor(finding: Finding, forbidden: readonly ForbiddenLabel[]): string | null {
  const hit = forbidden.find((label) => {
    if (label.file === undefined || label.file !== finding.file) return false;
    if (label.category !== undefined && label.category !== finding.category) return false;
    if (label.line_start === undefined || label.line_end === undefined) return true;
    return finding.line_start <= label.line_end && label.line_start <= finding.line_end;
  });
  return hit?.key ?? null;
}

/**
 * The label a false positive sits on under a category that label does not accept.
 *
 * Deliberately attribution rather than credit. ADR-025 could count an under-rated finding as
 * precise because a finding at the right lines *with the right category* has spotted the issue:
 * the category is part of what says which issue it is. Without it there is no telling a real
 * bug filed under another heading from a different claim made at the same place - sample-05
 * has both, on neighbouring lines. So the finding stays a false positive, and this names where
 * it landed so a person can read which of the two it was. `must_find` labels are preferred
 * because they are the ones whose miss the report is already explaining.
 */
function nearMissFor(finding: Finding, labels: GoldenLabels): string | null {
  const placed: PlacedLabel[] = [...labels.must_find, ...labels.acceptable];
  const hit = placed.find(
    (label) =>
      label.file === finding.file &&
      finding.line_start <= label.line_end &&
      label.line_start <= finding.line_end,
  );
  return hit?.key ?? null;
}

/** What the Verifier removed, by reason, in a stable order. */
function droppedByReason(review: ReviewResult): ReviewScore["dropped"] {
  const counts = new Map<string, number>();
  for (const d of review.dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([reason, count]) => ({ reason, count }));
}

/** Scores one sample's `review.json` against its labels. */
export function scoreReview(review: ReviewResult, labels: GoldenLabels): ReviewScore {
  const kept = review.findings;

  // Every finding that matched a label, with the label it matched, so calibration can be scored
  // over exactly the findings the other axes already counted - and never twice.
  const pairs: { finding: Finding; label: PlacedLabel }[] = [];

  const matched: Match[] = [];
  const missed: string[] = [];
  for (const label of labels.must_find) {
    const hit = kept.find((f) => found(f, label));
    if (hit) {
      matched.push({ key: label.key, finding_id: hit.id, severity: hit.severity });
      pairs.push({ finding: hit, label });
    } else missed.push(label.key);
  }

  // Optional issues the run spotted. Scored nowhere, but without them a run that says
  // something real and a run that says nothing are indistinguishable on a restraint sample.
  const optional: Match[] = [];
  for (const label of labels.acceptable) {
    const hit = kept.find((f) => locates(f, label));
    if (hit) {
      optional.push({ key: label.key, finding_id: hit.id, severity: hit.severity });
      pairs.push({ finding: hit, label });
    }
  }

  // On a must_find label the floor is already enforced by `found`, so an under-rated finding is
  // counted as missed and never arrives here: the band's ceiling is what it adds. On an
  // acceptable label, which `locates` matches without looking at severity at all, it adds both.
  const banded = pairs
    .map(({ finding, label }) => ({ finding, label, verdict: calibration(finding, label) }))
    .filter((p) => p.verdict !== null);
  const miscalibrated: Miscalibration[] = banded
    .filter((p) => p.verdict !== "in")
    .map(({ finding, label, verdict }) => ({
      key: label.key,
      finding_id: finding.id,
      severity: finding.severity,
      // Both are defined: `calibration` returned a verdict rather than null.
      max_severity: label.max_severity ?? finding.severity,
      min_severity: label.min_severity ?? finding.severity,
      direction: verdict === "over" ? ("over" as const) : ("under" as const),
    }));

  const placed: PlacedLabel[] = [...labels.must_find, ...labels.acceptable];

  // Two findings on one known issue say it twice. The scorer cannot read them and hear the same
  // sentence, but it can see them land on one label (ADR-029, roadmap step 7). `locates`, not
  // `found`: severity has no part in whether something was said twice.
  const redundant: Redundancy[] = placed
    .map((label) => ({
      key: label.key,
      finding_ids: kept.filter((f) => locates(f, label)).map((f) => f.id),
    }))
    .filter((r) => r.finding_ids.length > 1);

  const falsePositives: FalsePositive[] = kept
    .filter((f) => !placed.some((label) => locates(f, label)))
    .map((f) => {
      const named = nameFor(f, labels.must_not_flag);
      return {
        finding_id: f.id,
        file: f.file,
        line_start: f.line_start,
        line_end: f.line_end,
        category: f.category,
        severity: f.severity,
        summary: f.summary,
        must_not_flag_key: named,
        // A mistake the set already names is not also a near miss: the name is the better answer.
        near_miss_key: named === null ? nearMissFor(f, labels) : null,
      };
    });

  const budget = labels.max_findings;
  return {
    kept: kept.length,
    max_findings: budget ?? null,
    within_budget: budget === undefined || kept.length <= budget,
    precision: rate(kept.length - falsePositives.length, kept.length),
    recall: rate(matched.length, labels.must_find.length),
    found: matched,
    missed,
    acceptable_found: optional,
    false_positives: falsePositives,
    calibrated: rate(banded.length - miscalibrated.length, banded.length),
    calibration_scored: banded.length,
    miscalibrated,
    redundant,
    dropped: droppedByReason(review),
  };
}

/**
 * Measures a produced script against the sample's expected one.
 *
 * Nothing here re-checks markdown, file names or the word cap: `checkScript` enforces those
 * inside the Narrate stage, which fails rather than writing a script that breaks them
 * (ADR-024), so asserting them again could only ever pass. What is left is what the checks do
 * not constrain - how much was said, and whether it was said at all.
 *
 * A verified review that kept no findings has nothing to narrate, and producing no script for
 * it is the correct outcome rather than a failed stage (ADR-042): `narrated` is then null, the
 * way precision is null over an empty set. That is decided from the review, not from whether a
 * script or a failure arrived, so a clean sample cannot be mistaken for a Narrator that broke.
 */
export function measureScript(
  review: ReviewResult,
  script: NarrationScript | undefined,
  expected: NarrationScript | undefined,
  failure?: string,
): ScriptResult {
  if (review.findings.length === 0) return { narrated: null, failure: null };
  if (!script) return { narrated: false, failure: failure ?? null };

  const words = script.steps.map((s) => countWords(s.text));
  return {
    narrated: true,
    failure: null,
    steps: script.steps.length,
    words: words.reduce((sum, w) => sum + w, 0),
    max_step_words: Math.max(...words),
    estimated_seconds:
      Math.round(script.steps.reduce((sum, s) => sum + (s.estimated_seconds ?? 0), 0) * 10) / 10,
    ...(expected === undefined
      ? {}
      : {
          expected_steps: expected.steps.length,
          expected_seconds:
            Math.round(
              expected.steps.reduce((sum, s) => sum + (s.estimated_seconds ?? 0), 0) * 10,
            ) / 10,
        }),
  };
}

/**
 * Pools every sample's items into one score.
 *
 * Micro-averaged on purpose: a sample with one finding must not weigh as much as one with
 * four, and a sample with no `must_find` labels must not drag recall toward either end. Its
 * denominator contribution is zero, so restraint samples are scored on precision and their
 * false positives, which is what they exist to test.
 */
export function total(samples: readonly SampleResult[]): Totals {
  let mustFind = 0;
  let foundCount = 0;
  let optionalFound = 0;
  let kept = 0;
  let falsePositives = 0;
  let seconds = 0;
  let narrated = 0;
  let narratable = 0;
  let overBudget = 0;
  // Counted over findings rather than averaged over samples, so a sample with four banded
  // findings weighs four times one with a single banded finding.
  let banded = 0;
  let miscalibrated = 0;
  // Surplus findings: a label located three times contributes two.
  let redundant = 0;

  for (const s of samples) {
    mustFind += s.review.found.length + s.review.missed.length;
    foundCount += s.review.found.length;
    optionalFound += s.review.acceptable_found.length;
    kept += s.review.kept;
    falsePositives += s.review.false_positives.length;
    seconds += s.seconds ?? 0;
    // A sample with nothing to narrate is in neither count: no script was the right answer.
    if (s.script.narrated !== null) narratable += 1;
    if (s.script.narrated === true) narrated += 1;
    if (!s.review.within_budget) overBudget += 1;
    banded += s.review.calibration_scored ?? 0;
    miscalibrated += s.review.miscalibrated?.length ?? 0;
    for (const r of s.review.redundant ?? []) redundant += r.finding_ids.length - 1;
  }

  return {
    precision: rate(kept - falsePositives, kept),
    recall: rate(foundCount, mustFind),
    must_find: mustFind,
    found: foundCount,
    acceptable_found: optionalFound,
    kept,
    false_positives: falsePositives,
    calibrated: rate(banded - miscalibrated, banded),
    miscalibrated,
    redundant,
    seconds: Math.round(seconds * 10) / 10,
    narrated,
    narratable,
    over_budget: overBudget,
  };
}

/**
 * The same arithmetic as {@link total}, once per origin the set contains.
 *
 * A synthetic sample asks whether the model recognises a bug somebody wrote for it to find; a
 * real one asks whether it finds a bug that reached production. The second is the claim this
 * tool is for, and averaging the two produces a number that reads like it while resting on the
 * first. An origin with no samples gets no entry rather than an entry full of nulls, so a set
 * that is entirely one kind says so by omission instead of by a row of dashes.
 */
export function totalsByOrigin(samples: readonly SampleResult[]): OriginTotals[] {
  const origins: Origin[] = ["real", "synthetic"];
  const entries: OriginTotals[] = [];

  for (const origin of origins) {
    const mine = samples.filter((s) => s.origin === origin);
    if (mine.length === 0) continue;
    const t = total(mine);
    entries.push({
      origin,
      samples: mine.length,
      precision: t.precision,
      recall: t.recall,
      must_find: t.must_find,
      found: t.found,
      kept: t.kept,
      false_positives: t.false_positives,
      calibrated: t.calibrated ?? null,
      miscalibrated: t.miscalibrated ?? 0,
    });
  }

  return entries;
}

/** The share of a token budget past which `spr eval` says so. */
export const BUDGET_WARNING_SHARE = 0.5;

/**
 * Stages that used more than half of a token budget. Budgets are per agent, and a call that runs
 * out of output tokens truncates its JSON and fails validation rather than degrading, so the
 * useful signal is the approach, not the collision (roadmap step 3). Silent on today's set: the
 * heaviest agent used about a third of its output budget.
 */
export function budgetWarnings(
  stages: Readonly<Record<string, { inputTokens: number; outputTokens: number } | undefined>>,
  budgets: { inputTokens: number; outputTokens: number },
): BudgetWarning[] {
  const warnings: BudgetWarning[] = [];
  for (const [stage, used] of Object.entries(stages)) {
    if (used === undefined) continue;
    for (const budget of ["inputTokens", "outputTokens"] as const) {
      if (used[budget] > budgets[budget] * BUDGET_WARNING_SHARE) {
        warnings.push({ stage, budget, used: used[budget], limit: budgets[budget] });
      }
    }
  }
  return warnings;
}

/** The middle of sorted values, or the mean of the two middle ones; null when there are none. */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return Math.round((((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) * 1000) / 1000;
}

/**
 * The median and the extremes of one axis across seeds. An undefined value - a rate over an empty
 * set - is kept in `values`, so they stay aligned with the seeds, and left out of the summary.
 */
export function range(values: readonly (number | null)[]): Range {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return {
    median: median(known),
    min: known[0] ?? null,
    max: known[known.length - 1] ?? null,
    values: [...values],
  };
}

/**
 * must_find labels some seeds found and others missed, in sample order. A label every seed found,
 * or every seed missed, is not here: it does not move, whatever else does.
 */
export function unstableLabels(runs: readonly ModelRun[]): UnstableLabel[] {
  const foundBy = new Map<string, { sample: string; key: string; count: number }>();
  for (const run of runs) {
    for (const s of run.samples) {
      for (const key of [...s.review.found.map((m) => m.key), ...s.review.missed]) {
        const id = `${s.sample}\u0000${key}`;
        const entry = foundBy.get(id) ?? { sample: s.sample, key, count: 0 };
        if (s.review.found.some((m) => m.key === key)) entry.count += 1;
        foundBy.set(id, entry);
      }
    }
  }
  return [...foundBy.values()]
    .filter((e) => e.count > 0 && e.count < runs.length)
    .map((e) => ({ sample: e.sample, key: e.key, found_by: e.count, of: runs.length }));
}

/**
 * What each model read across its seeds (ADR-059). Runs without a seed are not part of any
 * spread, and a seed whose run failed partway is named and left out, because its totals cover
 * fewer samples and would read as a movement that is not there.
 */
export function spreads(runs: readonly ModelRun[]): Spread[] {
  const byModel = new Map<string, ModelRun[]>();
  for (const run of runs) {
    if (run.seed === undefined) continue;
    const id = `${run.provider}\u0000${run.model}`;
    byModel.set(id, [...(byModel.get(id) ?? []), run]);
  }

  return [...byModel.values()].flatMap((group) => {
    const [first] = group;
    if (first === undefined) return [];
    const complete = group.filter((r) => !r.failed);
    const axis = (pick: (t: Totals) => number | null | undefined): Range =>
      range(complete.map((r) => pick(r.totals) ?? null));
    return [
      {
        provider: first.provider,
        model: first.model,
        temperature: first.temperature ?? 0,
        seeds: complete.map((r) => r.seed ?? 0),
        incomplete_seeds: group.filter((r) => r.failed).map((r) => r.seed ?? 0),
        axes: {
          precision: axis((t) => t.precision),
          recall: axis((t) => t.recall),
          calibrated: axis((t) => t.calibrated),
          kept: axis((t) => t.kept),
          false_positives: axis((t) => t.false_positives),
          redundant: axis((t) => t.redundant ?? 0),
          not_narrated: axis((t) => (t.narratable ?? 0) - (t.narrated ?? 0)),
        },
        unstable: complete.length < 2 ? [] : unstableLabels(complete),
      },
    ];
  });
}

/** Builds the report written to `eval.json`. */
export function buildReport(
  goldenDir: string,
  models: EvalReport["models"],
  now: Date = new Date(),
): EvalReport {
  const measured = spreads(models);
  return {
    schema_version: "1.0",
    generated_at: now.toISOString(),
    golden_dir: goldenDir,
    models,
    ...(measured.length === 0 ? {} : { spreads: measured }),
  };
}
