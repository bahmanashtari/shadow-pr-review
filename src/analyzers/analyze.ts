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

/** Options for {@link analyze}. */
export interface AnalyzeOptions {
  /** Rules to run. Defaults to every rule; tests use this to isolate one. */
  rules?: readonly Rule[];
}

/**
 * Finds everything the rules can prove from the diff text.
 * Results are in diff order, then rule order, so the output is deterministic.
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
      for (const line of hunk.lines) {
        if (line.kind !== "add" || line.new === null) continue;
        const context: RuleContext = { path: file.path, layer, text: line.text, addedLines };

        for (const rule of rules) {
          const hit = rule.check(context);
          if (!hit) continue;
          findings.push({
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
          });
        }
      }
    }
  }

  return findings;
}

/** One line per finding, for the part of the prompt that tells the model what is already known. */
export function describeForPrompt(findings: readonly AnalyzerFinding[]): string {
  if (findings.length === 0) return "";
  return findings
    .map((f) => `- ${f.file}:${f.line_start} [${f.severity}/${f.category}] ${f.summary}`)
    .join("\n");
}
