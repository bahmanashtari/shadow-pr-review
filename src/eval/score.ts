/**
 * Scoring for `spr eval`: labels plus a produced review and script become numbers.
 *
 * Pure, with no I/O and no model, because the arithmetic is the part that has to be trusted.
 * The matching rule is the one `golden/README.md` states, and ADR-025 records the two places
 * where it needed a ruling the README left open.
 */
import { SEVERITY_RANK, countWords } from "../contracts/checks.js";
import type {
  EvalReport,
  FalsePositive,
  Match,
  ReviewScore,
  ScriptResult,
  SampleResult,
  Totals,
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

  const matched: Match[] = [];
  const missed: string[] = [];
  for (const label of labels.must_find) {
    const hit = kept.find((f) => found(f, label));
    if (hit) matched.push({ key: label.key, finding_id: hit.id, severity: hit.severity });
    else missed.push(label.key);
  }

  // Optional issues the run spotted. Scored nowhere, but without them a run that says
  // something real and a run that says nothing are indistinguishable on a restraint sample.
  const optional: Match[] = [];
  for (const label of labels.acceptable) {
    const hit = kept.find((f) => locates(f, label));
    if (hit) optional.push({ key: label.key, finding_id: hit.id, severity: hit.severity });
  }

  const placed: PlacedLabel[] = [...labels.must_find, ...labels.acceptable];
  const falsePositives: FalsePositive[] = kept
    .filter((f) => !placed.some((label) => locates(f, label)))
    .map((f) => ({
      finding_id: f.id,
      file: f.file,
      line_start: f.line_start,
      line_end: f.line_end,
      category: f.category,
      severity: f.severity,
      summary: f.summary,
      must_not_flag_key: nameFor(f, labels.must_not_flag),
    }));

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
 */
export function measureScript(
  script: NarrationScript | undefined,
  expected: NarrationScript | undefined,
  failure?: string,
): ScriptResult {
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
  let overBudget = 0;

  for (const s of samples) {
    mustFind += s.review.found.length + s.review.missed.length;
    foundCount += s.review.found.length;
    optionalFound += s.review.acceptable_found.length;
    kept += s.review.kept;
    falsePositives += s.review.false_positives.length;
    seconds += s.seconds ?? 0;
    if (s.script.narrated) narrated += 1;
    if (!s.review.within_budget) overBudget += 1;
  }

  return {
    precision: rate(kept - falsePositives, kept),
    recall: rate(foundCount, mustFind),
    must_find: mustFind,
    found: foundCount,
    acceptable_found: optionalFound,
    kept,
    false_positives: falsePositives,
    seconds: Math.round(seconds * 10) / 10,
    narrated,
    over_budget: overBudget,
  };
}

/** Builds the report written to `eval.json`. */
export function buildReport(
  goldenDir: string,
  models: EvalReport["models"],
  now: Date = new Date(),
): EvalReport {
  return {
    schema_version: "1.0",
    generated_at: now.toISOString(),
    golden_dir: goldenDir,
    models,
  };
}
