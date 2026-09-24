/**
 * The Review stage: deterministic rules first, then the model for the judgement calls.
 *
 * The split follows ADR-002 and the measurements behind it: every model run missed a layer
 * violation that is a single import line, while the model was the only thing that spotted a
 * raw email address leaking into a domain error. Each half does what it is good at.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { analyze, describeForPrompt, type AnalyzerFinding } from "../analyzers/analyze.js";
import { checkReview, compareFindings } from "../contracts/checks.js";
import type { IngestResult } from "../contracts/generated/ingest.js";
import type { Finding, ReviewResult } from "../contracts/generated/review.js";
import type { SprConfig } from "../contracts/generated/config.js";
import { loadSchema } from "../contracts/schemas.js";
import { assertContract } from "../contracts/validate.js";
import type { Budget } from "../harness/budget.js";
import type { LlmCache } from "../harness/cache.js";
import { runAgent } from "../harness/loop.js";
import type { Tracer } from "../harness/tracing.js";
import { ContractError } from "../lib/errors.js";
import type { LlmProvider } from "../providers/llm/types.js";
import { renderDiff } from "./diff-view.js";
import { buildReviewerPrompt, describeAlreadyReported } from "./prompts/reviewer.js";
import { buildReviewTools } from "./tools/review-tools.js";

/** File this stage writes. */
export const REVIEW_RAW_FILE = "review.raw.json";

/** Input for {@link runReview}. */
export interface RunReviewOptions {
  ingest: IngestResult;
  provider: LlmProvider;
  config: SprConfig;
  budget: Budget;
  tracer: Tracer;
  cache?: LlmCache;
  /** Absolute path of the checkout, when there is one. */
  repoRoot?: string;
}

/** What the stage produced. */
export interface ReviewOutcome {
  review: ReviewResult;
  /** Null when the model answered; otherwise why it did not, for example `budget:agentSteps`. */
  stopped: string | null;
  analyzerFindings: number;
  modelFindings: number;
}

/** The model is asked for findings and a summary; ids and source are the code's job. */
interface ModelAnswer {
  summary: string;
  findings: Omit<Finding, "id" | "verification">[];
}

/** Builds the schema the model must satisfy: the review contract without the code-owned parts. */
export function reviewerOutputSchema(maxFindings: number): Record<string, unknown> {
  const review = loadSchema("review");
  const defs = review.$defs as Record<string, Record<string, unknown>>;
  // Taken from the contract, never restated: a looser limit here would let the model write a
  // summary the harness accepts and `assertContract` then rejects, after the retries are gone.
  const summary = (review.properties as Record<string, unknown>).summary;
  const finding = structuredClone(defs.Finding) as Record<string, unknown>;
  const properties = finding.properties as Record<string, unknown>;
  delete properties.id;
  delete properties.verification;
  finding.required = (finding.required as string[]).filter((key) => key !== "id");

  return {
    title: "ReviewerAnswer",
    type: "object",
    additionalProperties: false,
    required: ["summary", "findings"],
    $defs: { Severity: defs.Severity, Category: defs.Category },
    properties: {
      summary,
      findings: { type: "array", maxItems: maxFindings, items: finding },
    },
  };
}

/** True when two findings are about the same thing, so only one should be reported. */
function overlaps(a: Omit<Finding, "id">, b: Omit<Finding, "id">): boolean {
  return (
    a.file === b.file &&
    a.category === b.category &&
    a.line_start <= b.line_end &&
    b.line_start <= a.line_end
  );
}

/** Strips the analyzer's bookkeeping so the result matches the contract exactly. */
function toFinding(f: AnalyzerFinding): Omit<Finding, "id"> {
  return {
    file: f.file,
    side: f.side,
    line_start: f.line_start,
    line_end: f.line_end,
    severity: f.severity,
    category: f.category,
    summary: f.summary,
    rationale: f.rationale,
    suggestion: f.suggestion,
    confidence: f.confidence,
    evidence: f.evidence,
  };
}

/**
 * Runs the analyzers and the Reviewer and returns a valid `review.raw.json`.
 * A budget stop is not an error: the analyzer findings alone still make a usable review.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewOutcome> {
  const { ingest, provider, config, budget, tracer } = options;

  const analyzerFindings = analyze(ingest);
  const tools = buildReviewTools({
    ingest,
    ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
  });

  const system = buildReviewerPrompt({ hasRepository: options.repoRoot !== undefined });
  const alreadyReported = describeAlreadyReported(describeForPrompt(analyzerFindings));

  const result = await runAgent({
    stage: "review",
    provider,
    system,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [`Review this change.`, alreadyReported, renderDiff(ingest)]
              .filter((part) => part !== "")
              .join("\n\n"),
          },
        ],
      },
    ],
    outputSchema: reviewerOutputSchema(config.review.maxRawFindings),
    budget,
    tracer,
    tools,
    // Only a checkout's tools can show the Reviewer what its prompt does not (ADR-060).
    lookBeforeAnswering: options.repoRoot !== undefined,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    maxOutputTokens: config.budgets.outputTokens,
    temperature: config.llm.temperature,
    ...(config.llm.seed === undefined ? {} : { seed: config.llm.seed }),
    maxRetries: config.llm.maxRetries,
  });

  const answer = result.value as ModelAnswer | undefined;
  const fromModel = answer?.findings ?? [];
  const fromAnalyzers = analyzerFindings.map(toFinding);

  // The analyzers proved their findings, so they win a tie; the model's duplicate is dropped.
  const kept = [
    ...fromAnalyzers,
    ...fromModel.filter((m) => !fromAnalyzers.some((a) => overlaps(a, m))),
  ]
    .sort(compareFindings)
    .slice(0, config.review.maxRawFindings);

  const review: ReviewResult = {
    schema_version: "1.0",
    source: ingest.source,
    summary: answer?.summary ?? summarizeWithoutModel(analyzerFindings, result.stopped),
    findings: kept.map((finding, i) => ({ ...finding, id: `F${String(i + 1).padStart(2, "0")}` })),
    dropped: [],
    stats: {
      files_reviewed: ingest.files.length,
      files_skipped: ingest.skipped.map((s) => ({ file: s.file, reason: s.reason })),
    },
  };

  assertContract("review", review);
  const problems = checkReview(review);
  if (problems.length > 0) throw new ContractError(REVIEW_RAW_FILE, problems);

  return {
    review,
    stopped: result.stopped,
    analyzerFindings: fromAnalyzers.length,
    modelFindings: review.findings.length - fromAnalyzers.length,
  };
}

/** A summary for the case where the model never answered. */
function summarizeWithoutModel(
  findings: readonly AnalyzerFinding[],
  stopped: string | null,
): string {
  const why =
    stopped === null ? "The model did not answer" : `The review stopped early (${stopped})`;
  if (findings.length === 0) {
    return `${why}, and the automated checks found nothing. This change has not been fully reviewed.`;
  }
  return (
    `${why}. Only the automated checks ran, and they found ${findings.length} ` +
    `${findings.length === 1 ? "problem" : "problems"}. This change has not been fully reviewed.`
  );
}

/** Writes `review.raw.json` into a run folder. */
export function writeReview(runDir: string, review: ReviewResult): void {
  writeFileSync(path.join(runDir, REVIEW_RAW_FILE), `${JSON.stringify(review, null, 2)}\n`, "utf8");
}

/** One line such as `5 findings: 2 from checks, 3 from the model`. */
export function summarizeReview(outcome: ReviewOutcome): string {
  const total = outcome.review.findings.length;
  const line =
    `${total} ${total === 1 ? "finding" : "findings"}: ` +
    `${outcome.analyzerFindings} from checks, ${outcome.modelFindings} from the model`;
  return outcome.stopped === null ? line : `${line}; stopped early (${outcome.stopped})`;
}
