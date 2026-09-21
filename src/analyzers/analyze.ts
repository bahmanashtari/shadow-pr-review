/**
 * Runs the deterministic rules over an `ingest.json` and turns their hits into findings the
 * review contract accepts. Pure: no model, no repository, no I/O.
 */
import type { IngestResult } from "../contracts/generated/ingest.js";
import type { Finding } from "../contracts/generated/review.js";
import { layerOf, RULES, type Rule, type RuleContext } from "./rules.js";

/** A finding before ids are assigned, plus the rule that produced it. */
export interface AnalyzerFinding extends Omit<Finding, "id" | "verification"> {
  /** Which rule fired, for the trace and for tests. */
  rule: string;
}

/**
 * Deterministic rules are high-precision heuristics, not proofs, so they do not claim 1.0.
 * The Verifier still checks them like anything else.
 */
const ANALYZER_CONFIDENCE = 0.95;

/** The longest `evidence` list `review.schema.json` allows. Extra offenders are not quoted. */
const MAX_EVIDENCE = 5;

/** Options for {@link analyze}. */
export interface AnalyzeOptions {
  /** Rules to run. Defaults to every rule; tests use this to isolate one. */
  rules?: readonly Rule[];
}

/**
 * Finds everything the rules can prove from the diff text.
 * Results are in diff order, then rule order, so the output is deterministic.
 *
 * **One rule firing several times in one hunk is one finding** (ADR-029). The rules are
 * per-line predicates, so a layering violation spread over two `import` statements used to
 * arrive as two findings with byte-identical summaries, and the Narrator dutifully spoke both:
 * the second step of `sample-01` said "This is the same problem as the previous one." The
 * hand-written `review.expected.json` for that sample has always treated it as one finding
 * with two quotes, which is the shape this produces.
 *
 * Merging is confined to a single hunk on purpose. `HunkIndex.hasRange` requires *every* line
 * between `line_start` and `line_end` to be in the diff, so a range spanning two hunks would
 * cross a gap and the Verifier would drop the merged finding as `lines_not_in_diff` - turning
 * two correct findings into none. A hunk's lines are contiguous by construction, so a range
 * inside one always exists.
 */
export function analyze(ingest: IngestResult, options: AnalyzeOptions = {}): AnalyzerFinding[] {
  const rules = options.rules ?? RULES;
  const findings: AnalyzerFinding[] = [];

  for (const file of ingest.files) {
    const layer = layerOf(file.path);
    const addedLines = file.hunks.flatMap((hunk) =>
      hunk.lines.filter((line) => line.kind === "add").map((line) => line.text),
    );

    for (const hunk of file.hunks) {
      // Findings still open for more lines of this hunk, by rule and verdict. Cleared per
      // hunk, which is what keeps a merged range inside one contiguous run of lines.
      const open = new Map<string, AnalyzerFinding>();

      for (const line of hunk.lines) {
        if (line.kind !== "add" || line.new === null) continue;
        const context: RuleContext = { path: file.path, layer, text: line.text, addedLines };

        for (const rule of rules) {
          const hit = rule.check(context);
          if (!hit) continue;
          // The summary is in the key as cheap insurance: every rule returns one fixed verdict
          // today, and if one ever varies, two different claims must not merge into one.
          const key = `${rule.key}\n${hit.summary}`;
          const started = open.get(key);

          if (started === undefined) {
            const finding: AnalyzerFinding = {
              rule: rule.key,
              file: file.path,
              side: "new",
              line_start: line.new,
              line_end: line.new,
              severity: hit.severity,
              category: hit.category,
              summary: hit.summary,
              rationale: hit.rationale,
              suggestion: hit.suggestion,
              confidence: ANALYZER_CONFIDENCE,
              // The rule fired on this exact line, so the evidence is verbatim by construction.
              evidence: [line.text.trim()],
            };
            open.set(key, finding);
            // Pushed on first sight, then widened, so the result stays in diff order.
            findings.push(finding);
          } else {
            started.line_end = line.new;
            if (started.evidence.length < MAX_EVIDENCE) started.evidence.push(line.text.trim());
          }
        }
      }
    }
  }

  return findings;
}

/** One line per finding, for the part of the prompt that tells the model what is already known. */
/**
 * A path as text a model reads: control characters escaped, so a path from a hostile diff cannot
 * start a new line of the list it appears in. Defence in depth - the list is `user` content.
 */
function printablePath(path: string): string {
  let out = "";
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code < 0x20) out += JSON.stringify(ch).slice(1, -1);
    else if (code === 0x7f) out += "\\u007f";
    else out += ch;
  }
  return out;
}

export function describeForPrompt(findings: readonly AnalyzerFinding[]): string {
  if (findings.length === 0) return "";
  return findings
    .map((f) => {
      // A merged finding covers a range, and the model is being told not to repeat it - so it
      // has to see every line that is already spoken for, not just the first.
      const at = f.line_end === f.line_start ? `${f.line_start}` : `${f.line_start}-${f.line_end}`;
      return `- ${printablePath(f.file)}:${at} [${f.severity}/${f.category}] ${f.summary}`;
    })
    .join("\n");
}
