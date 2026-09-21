/**
 * The table `spr eval` prints. Pure: scores in, lines out, so it can be tested without a run.
 *
 * The detail lines matter as much as the rates. "Recall 0.75" says something is wrong; the
 * missed key and the dropped reason say what to change.
 */
import type { EvalReport, ModelRun, SampleResult } from "../contracts/generated/eval.js";

/** A rate as a fixed-width string, or `-` when it is undefined rather than zero. */
function rate(value: number | null): string {
  return value === null ? "-" : value.toFixed(3);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

/** `1 sample` / `3 samples`, because a report is read by a person. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `5 steps / 51s (want 5 / 89s)`, or why there is no script. */
function scriptCell(sample: SampleResult): string {
  const s = sample.script;
  if (!s.narrated) return `not narrated`;
  const want =
    s.expected_steps === undefined
      ? ""
      : ` (want ${s.expected_steps} / ${s.expected_seconds ?? 0}s)`;
  return `${s.steps ?? 0} steps / ${s.estimated_seconds ?? 0}s${want}`;
}

/** `1 duplicate, 2 claim_not_supported`, or a dash. */
function droppedCell(sample: SampleResult): string {
  const d = sample.review.dropped;
  return d.length === 0 ? "-" : d.map((x) => `${x.count} ${x.reason}`).join(", ");
}

const COLUMNS = { sample: 30, kept: 5, rate: 7, fp: 4 };

/**
 * The real / synthetic split under the total, or one line when the set is all of a kind.
 *
 * A single origin gets prose rather than a row, because a row identical to TOTAL invites the
 * reader to compare two numbers that are the same number. The synthetic wording is the point
 * of the whole axis: it says what the rates above are a claim about.
 */
function originLines(run: ModelRun): string[] {
  const entries = run.by_origin ?? [];
  const [only] = entries;

  if (only === undefined) return [];
  if (entries.length === 1) {
    if (only.origin === "real") return [`  all ${plural(only.samples, "sample")} are real changes`];
    return [
      `  all ${plural(only.samples, "sample")} are synthetic: these rates say the model finds bugs`,
      `  written for it to find, which is a weaker claim than finding one that shipped`,
    ];
  }

  return entries.map((e) =>
    [
      pad(`  ${e.origin}`, COLUMNS.sample),
      padLeft(String(e.kept), COLUMNS.kept),
      padLeft(rate(e.precision), COLUMNS.rate),
      padLeft(rate(e.recall), COLUMNS.rate),
      padLeft(rate(e.calibrated ?? null), COLUMNS.rate),
      padLeft(String(e.false_positives ?? 0), COLUMNS.fp),
      `  ${plural(e.samples, "sample")}, ${e.found}/${e.must_find} must_find`,
    ].join(" "),
  );
}

/** One model's block: a row per sample, a total row, then the detail worth acting on. */
export function formatModel(run: ModelRun): string[] {
  const lines: string[] = [
    run.failed
      ? `${run.provider} / ${run.model}  INCOMPLETE - ${run.failed}`
      : `${run.provider} / ${run.model}`,
    [
      pad("sample", COLUMNS.sample),
      padLeft("kept", COLUMNS.kept),
      padLeft("prec", COLUMNS.rate),
      padLeft("rec", COLUMNS.rate),
      padLeft("cal", COLUMNS.rate),
      padLeft("fp", COLUMNS.fp),
      "  dropped / script",
    ].join(" "),
  ];

  for (const s of run.samples) {
    lines.push(
      [
        pad(s.sample, COLUMNS.sample),
        padLeft(String(s.review.kept), COLUMNS.kept),
        padLeft(rate(s.review.precision), COLUMNS.rate),
        padLeft(rate(s.review.recall), COLUMNS.rate),
        padLeft(rate(s.review.calibrated ?? null), COLUMNS.rate),
        padLeft(String(s.review.false_positives.length), COLUMNS.fp),
        `  ${droppedCell(s)} / ${scriptCell(s)}`,
      ].join(" "),
    );
  }

  const t = run.totals;
  lines.push(
    [
      pad("TOTAL", COLUMNS.sample),
      padLeft(String(t.kept), COLUMNS.kept),
      padLeft(rate(t.precision), COLUMNS.rate),
      padLeft(rate(t.recall), COLUMNS.rate),
      padLeft(rate(t.calibrated ?? null), COLUMNS.rate),
      padLeft(String(t.false_positives), COLUMNS.fp),
      `  ${t.found}/${t.must_find} must_find, +${t.acceptable_found ?? 0} optional, ` +
        `${t.narrated ?? 0}/${run.samples.length} narrated, ${t.seconds}s`,
    ].join(" "),
  );

  lines.push(...originLines(run));

  for (const s of run.samples) {
    const detail: string[] = [];
    if (s.review.missed.length > 0) detail.push(`missed: ${s.review.missed.join(", ")}`);
    if (!s.review.within_budget) {
      detail.push(`over budget: kept ${s.review.kept}, allowed ${s.review.max_findings ?? 0}`);
    }
    for (const fp of s.review.false_positives) {
      const name = fp.must_not_flag_key ?? "unlabelled";
      detail.push(
        `false positive ${fp.finding_id} (${name}) ${fp.category} ` +
          `${fp.file}:${fp.line_start}-${fp.line_end} - ${fp.summary}`,
      );
      // Said on its own line because it changes what the one above means: the finding may be
      // the right bug under the wrong heading, which only reading it can settle.
      if (fp.near_miss_key) {
        detail.push(`  on ${fp.near_miss_key}'s lines, filed under ${fp.category}`);
      }
    }
    for (const m of s.review.miscalibrated ?? []) {
      // The direction is the point: over-rating and under-rating call for opposite corrections.
      detail.push(
        `${m.direction}-rated ${m.finding_id} (${m.key}) ${m.severity}, ` +
          `band ${m.max_severity}..${m.min_severity}`,
      );
    }
    if (!s.script.narrated && s.script.failure) detail.push(`narrate failed: ${s.script.failure}`);
    if (detail.length > 0) {
      lines.push(`  ${s.sample}`);
      for (const line of detail) lines.push(`    ${line}`);
    }
  }

  return lines;
}

/** The side-by-side table, printed only when more than one model was scored. */
export function formatComparison(models: readonly ModelRun[]): string[] {
  const width = Math.max(...models.map((m) => m.model.length), 5) + 2;
  const lines = [
    [
      pad("model", width),
      padLeft("prec", COLUMNS.rate),
      padLeft("rec", COLUMNS.rate),
      padLeft("cal", COLUMNS.rate),
      padLeft("found", COLUMNS.rate),
      padLeft("opt", COLUMNS.fp),
      padLeft("fp", COLUMNS.fp),
      padLeft("over", COLUMNS.fp),
      padLeft("secs", 8),
    ].join(" "),
  ];
  for (const m of models) {
    lines.push(
      [
        pad(m.failed ? `${m.model} *` : m.model, width),
        padLeft(rate(m.totals.precision), COLUMNS.rate),
        padLeft(rate(m.totals.recall), COLUMNS.rate),
        padLeft(rate(m.totals.calibrated ?? null), COLUMNS.rate),
        padLeft(`${m.totals.found}/${m.totals.must_find}`, COLUMNS.rate),
        padLeft(String(m.totals.acceptable_found ?? 0), COLUMNS.fp),
        padLeft(String(m.totals.false_positives), COLUMNS.fp),
        padLeft(String(m.totals.over_budget ?? 0), COLUMNS.fp),
        padLeft(String(m.totals.seconds), 8),
      ].join(" "),
    );
  }
  if (models.some((m) => m.failed)) {
    lines.push("* incomplete: this row covers only the samples that ran, so it is not comparable.");
  }
  return lines;
}

/** The whole report as printable lines. */
export function formatReport(report: EvalReport): string[] {
  const lines: string[] = [];
  for (const run of report.models) {
    lines.push(...formatModel(run), "");
  }
  if (report.models.length > 1) lines.push("comparison", ...formatComparison(report.models), "");
  return lines;
}
