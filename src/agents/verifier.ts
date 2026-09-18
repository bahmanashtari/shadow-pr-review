/**
 * The Verifier agent: the second layer of the Verify stage (ARCHITECTURE section 3).
 *
 * The first layer is deterministic and already built - lines exist, evidence is verbatim, no
 * duplicates, capped at ten (ADR-023). What is left needs judgement: is the claim true of this
 * code, and is its severity right. This is that, one finding at a time.
 *
 * One call per finding, because the isolation is the point rather than an optimisation. A judge
 * shown all ten findings at once is shown the Reviewer's confidence and the other claims'
 * framing; a judge shown one claim and the lines it is about is checking the claim. It also
 * caches per finding (ADR-017), so re-running after one finding changes is free for the rest,
 * and a budget stop keeps every verdict already reached.
 *
 * This layer is optional by design. No model, no Ollama, a budget stop or an answer that will
 * not validate all land in the same place: the findings judged carry their verdict, the rest
 * keep what the first layer gave them, and `review.json` is written either way (ADR-037).
 */
import type { SprConfig } from "../contracts/generated/config.js";
import type { IngestResult } from "../contracts/generated/ingest.js";
import type { DroppedFinding, Finding, Severity } from "../contracts/generated/review.js";
import { SEVERITY_RANK } from "../contracts/checks.js";
import type { Budget } from "../harness/budget.js";
import type { LlmCache } from "../harness/cache.js";
import { runAgent } from "../harness/loop.js";
import type { Tracer } from "../harness/tracing.js";
import { StageError } from "../lib/errors.js";
import type { LlmProvider } from "../providers/llm/types.js";
import { renderRange } from "./diff-view.js";
import { buildVerifierPrompt } from "./prompts/verifier.js";

/** The drop reasons this layer may give. The mechanical ones belong to the first layer. */
export const AGENT_DROP_REASONS = ["claim_not_supported", "out_of_scope", "style_only"] as const;

/** A drop reason the agent is allowed to give. */
export type AgentDropReason = (typeof AGENT_DROP_REASONS)[number];

/** What the model is asked for, about one finding. */
export interface Verdict {
  verdict: "keep" | "downgrade" | "drop";
  /** Present on a downgrade: the severity the finding should carry instead. */
  severity?: Severity;
  /** Present on a drop. */
  reason?: AgentDropReason;
  note: string;
}

/** What {@link judgeFindings} decided, by finding id. */
export type Verdicts = ReadonlyMap<string, Verdict>;

/** Input for {@link judgeFindings}. */
export interface JudgeOptions {
  findings: readonly Finding[];
  ingest: IngestResult;
  provider: LlmProvider;
  config: SprConfig;
  budget: Budget;
  tracer: Tracer;
  cache?: LlmCache;
}

/** What the agent pass produced. */
export interface JudgeOutcome {
  verdicts: Verdicts;
  /** Null when every finding was judged, otherwise why the pass stopped early. */
  stopped: string | null;
  /** Findings whose verdict could not be obtained. They keep what the first layer gave them. */
  failed: number;
}

/** The schema one verdict must satisfy. Also constrains decoding on Ollama. */
export function verdictSchema(): Record<string, unknown> {
  return {
    title: "Verdict",
    type: "object",
    additionalProperties: false,
    required: ["verdict", "note"],
    properties: {
      verdict: { enum: ["keep", "downgrade", "drop"] },
      severity: { enum: ["critical", "high", "medium", "low"] },
      reason: { enum: [...AGENT_DROP_REASONS] },
      note: { type: "string", minLength: 1, maxLength: 500 },
    },
  };
}

/**
 * The cross-field rules the schema cannot express: a downgrade needs a severity, a drop needs a
 * reason, and neither may carry the other's field. Fed back to the model as a repair.
 */
export function checkVerdict(value: unknown, finding: Finding): string[] {
  const verdict = value as Verdict;
  const problems: string[] = [];

  if (verdict.verdict === "downgrade") {
    if (verdict.severity === undefined) problems.push("A downgrade must give a severity.");
    else if (SEVERITY_RANK[verdict.severity] <= SEVERITY_RANK[finding.severity]) {
      problems.push(
        `A downgrade must lower the severity. The finding is ${finding.severity} and you ` +
          `answered ${verdict.severity}. If you think it is at least as serious, answer keep.`,
      );
    }
    if (verdict.reason !== undefined) problems.push("Only a drop takes a reason.");
  }

  if (verdict.verdict === "drop") {
    if (verdict.reason === undefined) problems.push("A drop must give a reason.");
    if (verdict.severity !== undefined) problems.push("Only a downgrade takes a severity.");
  }

  if (verdict.verdict === "keep") {
    if (verdict.severity !== undefined) problems.push("Only a downgrade takes a severity.");
    if (verdict.reason !== undefined) problems.push("Only a drop takes a reason.");
  }

  return problems;
}

/** One claim as the agent sees it: the finding's own words and the lines it is about. */
export function describeClaim(finding: Finding, code: string): string {
  return [
    `A reviewer reported this finding. Judge it.`,
    "",
    `Severity: ${finding.severity}`,
    `Category: ${finding.category}`,
    `File: ${finding.file}`,
    `Lines: ${String(finding.line_start)} to ${String(finding.line_end)} (${finding.side} side)`,
    `Claim: ${finding.summary}`,
    `Reasoning: ${finding.rationale}`,
    `Suggested fix: ${finding.suggestion}`,
    `Quoted as evidence:`,
    ...finding.evidence.map((line) => `  ${line}`),
    "",
    `The change, at those lines:`,
    "",
    code,
  ].join("\n");
}

/**
 * Judges each finding in turn.
 *
 * A finding whose verdict cannot be obtained - a budget stop, a model that will not produce a
 * valid answer, a file the ingest no longer has - is simply left out of the map, and the caller
 * keeps what the deterministic layer decided for it. The pass stops at the first budget refusal
 * rather than trying the rest, because a budget that is spent stays spent.
 */
export async function judgeFindings(options: JudgeOptions): Promise<JudgeOutcome> {
  const { findings, ingest, config } = options;
  const verdicts = new Map<string, Verdict>();
  const system = buildVerifierPrompt();
  let stopped: string | null = null;
  let failed = 0;

  for (const finding of findings) {
    const file = ingest.files.find((f) => f.path === finding.file);
    const code =
      file === undefined ? undefined : renderRange(file, finding.line_start, finding.line_end);
    // The first layer proved the range exists, so this is defensive rather than expected.
    if (code === undefined) continue;

    let result;
    try {
      result = await runAgent({
        stage: "verify",
        provider: options.provider,
        system,
        messages: [
          { role: "user", content: [{ type: "text", text: describeClaim(finding, code) }] },
        ],
        outputSchema: verdictSchema(),
        budget: options.budget,
        tracer: options.tracer,
        check: (value) => checkVerdict(value, finding),
        ...(options.cache === undefined ? {} : { cache: options.cache }),
        maxOutputTokens: config.budgets.outputTokens,
        temperature: config.llm.temperature,
        maxRetries: config.llm.maxRetries,
      });
    } catch (error) {
      // A model that will not produce a valid verdict after its repairs is a verdict this run
      // does not get, not a reason to throw away a review the first layer already grounded.
      // The count reaches the CLI line, so a run where the judge could not answer is visible.
      if (!(error instanceof StageError)) throw error;
      failed += 1;
      continue;
    }

    if (result.stopped !== null) {
      stopped = result.stopped;
      break;
    }
    if (result.value !== undefined) verdicts.set(finding.id, result.value as Verdict);
  }

  return { verdicts, stopped, failed };
}

/** Applies a downgrade to a finding, recording what it used to be. */
export function downgrade(finding: Finding, verdict: Verdict): Finding {
  return {
    ...finding,
    severity: verdict.severity ?? finding.severity,
    verification: {
      status: "downgraded",
      original_severity: finding.severity,
      note: verdict.note,
    },
  };
}

/** Turns a dropped verdict into the `dropped` entry the contract asks for. */
export function toDropped(finding: Finding, verdict: Verdict): DroppedFinding {
  return {
    id: finding.id,
    file: finding.file,
    line_start: finding.line_start,
    line_end: finding.line_end,
    summary: finding.summary,
    reason: verdict.reason ?? "claim_not_supported",
    note: verdict.note,
  };
}
