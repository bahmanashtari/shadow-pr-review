/**
 * Cross-field and cross-file rules that JSON Schema cannot express.
 * Every function returns a list of problems; an empty list means the value is consistent.
 * Rules that need the diff (lines exist, evidence appears) arrive with the hunk index
 * in Milestone 1 step 2 and live in the ingest/verify code.
 */
import type { ReviewResult, Severity } from "./generated/review.js";
import type { NarrationScript } from "./generated/script.js";
import type { AudioManifest } from "./generated/audio-manifest.js";
import type { Timeline } from "./generated/timeline.js";

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Characters that must never appear in spoken text. */
const MARKDOWN_PATTERN = /[`*#_[\]<>|]|^\s*[-+]\s/m;
/** A path-like token or a file extension such as `.ts`, `.json`, `/src/`. */
const FILE_REFERENCE_PATTERN =
  /\b[\w-]+\.(ts|tsx|js|mjs|cjs|json|sql|ya?ml|md|patch)\b|\w\/\w+\/|https?:\/\//i;

/** Counts spoken words (whitespace separated). */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  return [...dup];
}

/** Checks a review.json for rules beyond its schema. */
export function checkReview(review: ReviewResult): string[] {
  const problems: string[] = [];

  const ids = [...review.findings.map((f) => f.id), ...review.dropped.map((d) => d.id)];
  for (const id of duplicates(ids)) problems.push(`finding id ${id} is used more than once`);

  review.findings.forEach((f, i) => {
    const at = `/findings/${i} (${f.id})`;
    if (f.line_end < f.line_start) {
      problems.push(`${at}: line_end ${f.line_end} is before line_start ${f.line_start}`);
    }
    const v = f.verification;
    if (v?.status === "downgraded") {
      if (!v.original_severity) {
        problems.push(`${at}: downgraded finding needs verification.original_severity`);
      } else if (SEVERITY_RANK[v.original_severity] >= SEVERITY_RANK[f.severity]) {
        problems.push(
          `${at}: original_severity ${v.original_severity} must be higher than severity ${f.severity}`,
        );
      }
    }
    const prev = review.findings[i - 1];
    if (prev && SEVERITY_RANK[prev.severity] > SEVERITY_RANK[f.severity]) {
      problems.push(`${at}: findings must be ordered by severity (critical first)`);
    }
  });

  review.dropped.forEach((d, i) => {
    if (d.line_start != null && d.line_end != null && d.line_end < d.line_start) {
      problems.push(`/dropped/${i} (${d.id}): line_end is before line_start`);
    }
  });

  return problems;
}

/** Options for {@link checkScript}. */
export interface ScriptCheckOptions {
  /** Maximum spoken words per step (NARRATION_STYLE.md). */
  maxWordsPerStep?: number;
}

/** Checks a script.json on its own and against the review it narrates. */
export function checkScript(
  script: NarrationScript,
  review: ReviewResult,
  options: ScriptCheckOptions = {},
): string[] {
  const maxWords = options.maxWordsPerStep ?? 60;
  const problems: string[] = [];
  const steps = script.steps;

  if (steps[0]?.kind !== "intro") problems.push("first step must be kind 'intro'");
  if (steps.at(-1)?.kind !== "wrap_up") problems.push("last step must be kind 'wrap_up'");

  for (const id of duplicates(steps.map((s) => s.id))) {
    problems.push(`step id ${id} is used more than once`);
  }

  const findings = new Map(review.findings.map((f) => [f.id, f]));
  const narrated = new Set<string>();

  steps.forEach((s, i) => {
    const at = `/steps/${i} (${s.id})`;
    const expectedId = `S${String(i).padStart(2, "0")}`;
    if (s.id !== expectedId) problems.push(`${at}: expected id ${expectedId}`);

    if (s.kind !== "finding") {
      if (s.finding_id !== null) problems.push(`${at}: ${s.kind} step must have finding_id null`);
      if (s.focus !== null) problems.push(`${at}: ${s.kind} step must have focus null`);
      if (i > 0 && i < steps.length - 1)
        problems.push(`${at}: ${s.kind} step must be first or last`);
    } else {
      const finding = s.finding_id === null ? undefined : findings.get(s.finding_id);
      if (!finding) {
        problems.push(
          `${at}: finding_id ${String(s.finding_id)} is not a kept finding in review.json`,
        );
      } else {
        if (narrated.has(finding.id))
          problems.push(`${at}: finding ${finding.id} is narrated twice`);
        narrated.add(finding.id);
        const f = s.focus;
        if (
          !f ||
          f.file !== finding.file ||
          f.side !== finding.side ||
          f.line_start !== finding.line_start ||
          f.line_end !== finding.line_end
        ) {
          problems.push(`${at}: focus must equal the location of finding ${finding.id}`);
        }
      }
    }

    const words = countWords(s.text);
    if (words > maxWords) problems.push(`${at}: ${words} words, maximum is ${maxWords}`);
    if (MARKDOWN_PATTERN.test(s.text))
      problems.push(`${at}: text contains markdown or code characters`);
    if (FILE_REFERENCE_PATTERN.test(s.text))
      problems.push(`${at}: text reads out a file name, path or URL`);
  });

  for (const f of review.findings) {
    if (!narrated.has(f.id)) problems.push(`finding ${f.id} has no narration step`);
  }

  const order = steps.flatMap((s) => (s.finding_id ? [s.finding_id] : []));
  const expectedOrder = review.findings.map((f) => f.id).filter((id) => narrated.has(id));
  if (order.join() !== expectedOrder.join()) {
    problems.push("finding steps must follow the order of findings in review.json");
  }

  return problems;
}

/** Checks an audio manifest against the script it voices. */
export function checkAudioManifest(manifest: AudioManifest, script: NarrationScript): string[] {
  const problems: string[] = [];
  const clipIds = manifest.clips.map((c) => c.step_id);
  for (const id of duplicates(clipIds)) problems.push(`clip for step ${id} appears more than once`);
  const stepIds = script.steps.map((s) => s.id);
  if (clipIds.join() !== stepIds.join()) {
    problems.push(
      `clips (${clipIds.join(", ")}) must match script steps (${stepIds.join(", ")}) in order`,
    );
  }
  return problems;
}

/** Checks a timeline for internal consistency and against the manifest durations. */
export function checkTimeline(timeline: Timeline, manifest?: AudioManifest): string[] {
  const problems: string[] = [];
  const windows = timeline.step_windows;

  windows.forEach((w, i) => {
    if (w.end_ms <= w.start_ms) problems.push(`/step_windows/${i}: end_ms must be after start_ms`);
    const prev = windows[i - 1];
    if (prev && w.start_ms !== prev.end_ms + timeline.gap_ms) {
      problems.push(`/step_windows/${i}: start_ms must equal previous end_ms + gap_ms`);
    }
  });

  const last = windows.at(-1);
  if (last && timeline.total_duration_ms < last.end_ms) {
    problems.push("total_duration_ms is shorter than the last step window");
  }

  const windowIds = new Set(windows.map((w) => w.step_id));
  timeline.actions.forEach((a, i) => {
    const at = `/actions/${i}`;
    if (!windowIds.has(a.step_id)) problems.push(`${at}: step ${a.step_id} has no step window`);
    const prev = timeline.actions[i - 1];
    if (prev && a.at_ms < prev.at_ms) problems.push(`${at}: actions must be sorted by at_ms`);
    if (a.at_ms > timeline.total_duration_ms)
      problems.push(`${at}: at_ms is after total_duration_ms`);
    const needsRange = a.type === "scroll_to" || a.type === "highlight";
    if (
      needsRange &&
      (a.file === undefined || a.line_start === undefined || a.line_end === undefined)
    ) {
      problems.push(`${at}: ${a.type} needs file, line_start and line_end`);
    }
    if (a.type === "open_file" && a.file === undefined)
      problems.push(`${at}: open_file needs file`);
    if (a.line_start !== undefined && a.line_end !== undefined && a.line_end < a.line_start) {
      problems.push(`${at}: line_end is before line_start`);
    }
  });

  if (manifest) {
    const durations = new Map(manifest.clips.map((c) => [c.step_id, c.duration_ms]));
    windows.forEach((w, i) => {
      const d = durations.get(w.step_id);
      if (d === undefined) problems.push(`/step_windows/${i}: no audio clip for ${w.step_id}`);
      else if (w.end_ms - w.start_ms !== d) {
        problems.push(`/step_windows/${i}: window length must equal clip duration ${d} ms`);
      }
    });
  }

  return problems;
}
