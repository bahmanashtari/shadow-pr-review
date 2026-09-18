/**
 * Cross-field and cross-file rules that JSON Schema cannot express.
 * Every function returns a list of problems; an empty list means the value is consistent.
 * Rules that need the diff (lines exist, evidence appears) live in `ingest/hunk-index.ts`.
 */
import type { IngestResult, KeptFile } from "./generated/ingest.js";
import type { Finding, ReviewResult, Severity } from "./generated/review.js";
import type { NarrationScript } from "./generated/script.js";
import type { AudioManifest } from "./generated/audio-manifest.js";
import type { Timeline } from "./generated/timeline.js";

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** The parts of a finding that decide where it sits in the list. */
type Placed = Pick<Finding, "severity" | "file" | "line_start">;

/**
 * The order `review.schema.json` requires: severity first (critical first), then file, then
 * line. The Reviewer sorts with it, the Verifier re-sorts with it, and {@link checkReview}
 * enforces it, so all three agree by construction.
 */
export function compareFindings(a: Placed, b: Placed): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line_start - b.line_start;
}

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

/** Options for {@link checkReview}. */
export interface ReviewCheckOptions {
  /**
   * Maximum kept findings. Set it to `review.maxFindings` when checking a verified
   * `review.json`; leave it unset for `review.raw.json`, which may carry up to
   * `review.maxRawFindings` (ADR-016).
   */
  maxFindings?: number;
}

/** Checks a review.json for rules beyond its schema. */
export function checkReview(review: ReviewResult, options: ReviewCheckOptions = {}): string[] {
  const problems: string[] = [];

  const { maxFindings } = options;
  if (maxFindings !== undefined && review.findings.length > maxFindings) {
    problems.push(`${review.findings.length} findings, maximum is ${maxFindings}`);
  }

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
    if (prev && compareFindings(prev, f) > 0) {
      problems.push(
        `${at}: findings must be ordered by severity (critical first), then file and line`,
      );
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

/** What NARRATION_STYLE.md allows an intro or a wrap-up to run to. */
const FRAME_WORDS = { min: 15, max: 40 } as const;

/**
 * The severity words the outro card counts, and which the narration may therefore only speak
 * when the review supports them.
 */
const SEVERITY_WORDS: readonly Severity[] = ["critical", "high", "medium", "low"];

/**
 * Severity words an intro or wrap-up speaks that no kept finding carries.
 *
 * The voice and the outro card read different sources: the card counts each finding's
 * `severity` field, while the Narrator's user message opens with the Reviewer's prose summary,
 * which on every golden sample begins "Critical ...". So `sample-03` ended up with a card
 * reading "1 issue to fix - 1 low" over a narration saying "critical" three times (ADR-034,
 * ADR-037). This is the rule that stops that reaching a viewer.
 *
 * Deliberately literal, and its false positive is accepted (plan m3-step9, Q2): "it is critical
 * that this is fixed" is refused on a review with no critical finding. The repair loop rewords
 * it, only the two frame steps are checked, and the alternative - matching the word only in a
 * severity-shaped context - is a parser guessing at meaning. If it ever proves annoying, drop a
 * word from the list rather than make the check clever.
 *
 * Only the intro and wrap-up are checked. A finding step is given its finding's severity
 * directly and uses it correctly, and constraining it would forbid "this one is the
 * high-severity one", which is exactly what that step should be able to say.
 */
function unsupportedSeverityWords(text: string, present: ReadonlySet<Severity>): Severity[] {
  const lower = text.toLowerCase();
  return SEVERITY_WORDS.filter(
    (word) => !present.has(word) && new RegExp(`\\b${word}\\b`).test(lower),
  );
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
  const severitiesPresent = new Set(review.findings.map((f) => f.severity));

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
    if (s.kind !== "finding" && (words < FRAME_WORDS.min || words > FRAME_WORDS.max)) {
      problems.push(
        `${at}: ${words} words, but an intro or wrap-up must be ` +
          `${FRAME_WORDS.min} to ${FRAME_WORDS.max}`,
      );
    }
    if (s.kind !== "finding") {
      for (const word of unsupportedSeverityWords(s.text, severitiesPresent)) {
        problems.push(
          `${at}: says "${word}", but no kept finding is ${word}. The outro card counts the ` +
            `severity field, so the narration has to agree with it. Use a word the review ` +
            `supports, or describe the consequence instead of rating it.`,
        );
      }
    }
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

/** Checks one kept file's hunks: line counts, numbering, and end-of-file markers. */
function checkKeptFile(file: KeptFile, at: string): string[] {
  const problems: string[] = [];
  let additions = 0;
  let deletions = 0;
  const sides = { old: [] as boolean[], new: [] as boolean[] };

  file.hunks.forEach((hunk, h) => {
    const where = `${at}/hunks/${h}`;
    let oldCount = 0;
    let newCount = 0;
    let oldNext = hunk.old_start;
    let newNext = hunk.new_start;

    hunk.lines.forEach((line, l) => {
      const lineAt = `${where}/lines/${l}`;
      const onOld = line.kind !== "add";
      const onNew = line.kind !== "del";

      if (onOld && line.old === null) problems.push(`${lineAt}: ${line.kind} line needs old`);
      if (!onOld && line.old !== null) problems.push(`${lineAt}: add line must have old null`);
      if (onNew && line.new === null) problems.push(`${lineAt}: ${line.kind} line needs new`);
      if (!onNew && line.new !== null) problems.push(`${lineAt}: del line must have new null`);

      if (onOld) {
        oldCount += 1;
        if (hunk.old_lines > 0 && line.old !== null && line.old !== oldNext) {
          problems.push(`${lineAt}: old line ${line.old} breaks the run from ${hunk.old_start}`);
        }
        oldNext += 1;
        sides.old.push(line.no_newline_at_eof === true);
      }
      if (onNew) {
        newCount += 1;
        if (hunk.new_lines > 0 && line.new !== null && line.new !== newNext) {
          problems.push(`${lineAt}: new line ${line.new} breaks the run from ${hunk.new_start}`);
        }
        newNext += 1;
        sides.new.push(line.no_newline_at_eof === true);
      }
      if (line.kind === "add") additions += 1;
      if (line.kind === "del") deletions += 1;
    });

    if (oldCount !== hunk.old_lines) {
      problems.push(`${where}: header says ${hunk.old_lines} old lines, found ${oldCount}`);
    }
    if (newCount !== hunk.new_lines) {
      problems.push(`${where}: header says ${hunk.new_lines} new lines, found ${newCount}`);
    }
  });

  if (file.additions !== additions) {
    problems.push(`${at}: additions ${file.additions} does not match ${additions} added lines`);
  }
  if (file.deletions !== deletions) {
    problems.push(`${at}: deletions ${file.deletions} does not match ${deletions} deleted lines`);
  }

  for (const side of ["old", "new"] as const) {
    const flags = sides[side];
    const marked = flags.flatMap((flag, i) => (flag ? [i] : []));
    if (marked.length > 1) {
      problems.push(`${at}: no_newline_at_eof appears ${marked.length} times on the ${side} side`);
    } else if (marked.length === 1 && marked[0] !== flags.length - 1) {
      problems.push(`${at}: no_newline_at_eof is not on the last ${side} line`);
    }
  }

  return problems;
}

/** Checks an ingest.json for rules beyond its schema. */
export function checkIngest(ingest: IngestResult): string[] {
  const problems: string[] = [];

  const paths = [...ingest.files.map((f) => f.path), ...ingest.skipped.map((s) => s.file)];
  for (const path of duplicates(paths)) problems.push(`file ${path} appears more than once`);

  ingest.files.forEach((file, i) => {
    problems.push(...checkKeptFile(file, `/files/${i} (${file.path})`));
  });

  const stats = ingest.stats;
  const additions = ingest.files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = ingest.files.reduce((sum, f) => sum + f.deletions, 0);
  if (stats.files_kept !== ingest.files.length) {
    problems.push(`stats.files_kept ${stats.files_kept} does not match ${ingest.files.length}`);
  }
  if (stats.files_skipped !== ingest.skipped.length) {
    problems.push(
      `stats.files_skipped ${stats.files_skipped} does not match ${ingest.skipped.length}`,
    );
  }
  if (stats.files_total !== ingest.files.length + ingest.skipped.length) {
    problems.push(
      `stats.files_total ${stats.files_total} does not match ${ingest.files.length + ingest.skipped.length}`,
    );
  }
  if (stats.additions !== additions) {
    problems.push(`stats.additions ${stats.additions} does not match ${additions}`);
  }
  if (stats.deletions !== deletions) {
    problems.push(`stats.deletions ${stats.deletions} does not match ${deletions}`);
  }

  return problems;
}
