/**
 * The Narrate stage: `review.json` becomes `script.json`, the spoken walkthrough.
 *
 * The shape of a script is not a judgement call - `checkScript` already fixes the step order,
 * the ids and the focus - so the model is asked only for the words and the code builds the file
 * (ADR-024). Its input is the verified review and nothing else: never the diff, which keeps the
 * Narrator from inventing an issue it was not handed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkScript, countWords } from "../contracts/checks.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { Finding, ReviewResult } from "../contracts/generated/review.js";
import type { NarrationScript, Step } from "../contracts/generated/script.js";
import { loadSchema } from "../contracts/schemas.js";
import { assertContract, validateContract } from "../contracts/validate.js";
import type { Budget } from "../harness/budget.js";
import type { LlmCache } from "../harness/cache.js";
import { runAgent } from "../harness/loop.js";
import type { Tracer } from "../harness/tracing.js";
import { ContractError, StageError } from "../lib/errors.js";
import type { LlmProvider } from "../providers/llm/types.js";
import { buildNarratorPrompt } from "./prompts/narrator.js";

/** File this stage writes. */
export const SCRIPT_FILE = "script.json";

/** Where a draft that failed the narration rules is left, for a person to finish by hand. */
export const REJECTED_SCRIPT_FILE = "script.rejected.json";

/** Spoken words per second, the rate `script.schema.json` estimates with. */
const WORDS_PER_SECOND = 2.5;

/** The longest a title card may be, from `script.schema.json`. */
const MAX_TITLE = 100;

/** What the model is asked for: the words, paired with the finding each one is about. */
export interface NarratorAnswer {
  intro: string;
  steps: { finding_id: string; text: string }[];
  wrap_up: string;
}

/** Input for {@link runNarrate}. */
export interface RunNarrateOptions {
  review: ReviewResult;
  provider: LlmProvider;
  config: SprConfig;
  budget: Budget;
  tracer: Tracer;
  cache?: LlmCache;
  /** Run folder, so a rejected draft can be left behind when the stage fails. */
  runDir: string;
}

/** What the stage produced. */
export interface NarrateOutcome {
  script: NarrationScript;
  /** How many repairs the model needed before its narration passed the checks. */
  attempts: number;
}

/**
 * Builds the schema the model must satisfy: one text per finding, in the review's order.
 *
 * The `finding_id` enum and the exact step count pin the answer hard, which on Ollama also
 * constrains decoding. The id is redundant with the position on purpose: it is a checksum, so
 * a model that drifts by one and narrates the migration in the consumer's slot produces an
 * answer that still parses and is still caught, by `checkScript`'s ordering rule.
 */
export function narratorOutputSchema(review: ReviewResult): Record<string, unknown> {
  const script = loadSchema("script");
  const defs = script.$defs as Record<string, Record<string, unknown>>;
  const step = defs.Step as Record<string, unknown>;
  const text = (step.properties as Record<string, unknown>).text;
  const ids = review.findings.map((f) => f.id);

  return {
    title: "NarratorAnswer",
    type: "object",
    additionalProperties: false,
    required: ["intro", "steps", "wrap_up"],
    properties: {
      intro: text,
      wrap_up: text,
      steps: {
        type: "array",
        minItems: ids.length,
        maxItems: ids.length,
        // A clean change narrates nothing, and an empty `enum` is not a legal schema.
        ...(ids.length === 0
          ? {}
          : {
              items: {
                type: "object",
                additionalProperties: false,
                required: ["finding_id", "text"],
                properties: { finding_id: { enum: ids }, text },
              },
            }),
      },
    },
  };
}

/** The title card: the change's own title, or a plain fallback when the source has none. */
export function scriptTitle(review: ReviewResult): string {
  const given = review.source.title?.trim();
  const title = given === undefined || given === "" ? "Code review" : `Review: ${given}`;
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 3)}...`;
}

/** Word count over the schema's speaking rate, to one decimal. */
function estimateSeconds(text: string): number {
  return Math.round((countWords(text) / WORDS_PER_SECOND) * 10) / 10;
}

/** A step before the code numbers it and times it, which it can only do once they are in order. */
type Unnumbered = Omit<Step, "id" | "estimated_seconds">;

/** An intro or wrap-up step, which points at no finding and highlights nothing. */
function frameStep(kind: "intro" | "wrap_up", text: string): Unnumbered {
  return { kind, finding_id: null, text, subtitle: null, focus: null };
}

/** Where on screen a finding's step looks. */
function focusOf(finding: Finding): Step["focus"] {
  return {
    file: finding.file,
    side: finding.side,
    line_start: finding.line_start,
    line_end: finding.line_end,
  };
}

/**
 * Turns the model's texts into a script. Pure, and total: a step naming a finding that is not
 * in the review is left out rather than throwing, so every pairing mistake is reported by
 * `checkScript` in the language the model can repair, instead of crashing the stage.
 */
export function assembleScript(
  answer: NarratorAnswer,
  review: ReviewResult,
  config: SprConfig,
): NarrationScript {
  const byId = new Map(review.findings.map((f) => [f.id, f]));

  const narrated: Unnumbered[] = answer.steps.flatMap((step) => {
    const finding = byId.get(step.finding_id);
    if (finding === undefined) return [];
    return [
      {
        kind: "finding" as const,
        finding_id: finding.id,
        text: step.text,
        subtitle: null,
        focus: focusOf(finding),
      },
    ];
  });

  const steps = [
    frameStep("intro", answer.intro),
    ...narrated,
    frameStep("wrap_up", answer.wrap_up),
  ].map((step, i) => ({
    ...step,
    id: `S${String(i).padStart(2, "0")}`,
    estimated_seconds: estimateSeconds(step.text),
  }));

  return {
    schema_version: "1.0",
    title: scriptTitle(review),
    language: config.narration.language,
    steps,
  };
}

/** One finding as the model sees it: the review's own words, plus the lines it is about. */
function describeFinding(finding: Finding): string {
  return [
    `${finding.id} - ${finding.severity}, ${finding.category}`,
    `In: ${finding.file}`,
    `What: ${finding.summary}`,
    `Why: ${finding.rationale}`,
    `Fix: ${finding.suggestion}`,
    `Code:`,
    ...finding.evidence.map((line) => `  ${line}`),
  ].join("\n");
}

/** The user message: the change's summary and every finding to narrate, in order. */
export function describeReview(review: ReviewResult): string {
  const head = `The change: ${review.summary}`;
  if (review.findings.length === 0) {
    return (
      `${head}\n\nNothing was found worth reporting. Write only the intro and the wrap-up: ` +
      `say the change looks good, and name one or two things it does well.`
    );
  }
  return [
    head,
    `Narrate these ${review.findings.length} findings, in this order:`,
    ...review.findings.map(describeFinding),
  ].join("\n\n");
}

/** Runs the Narrator and returns a valid `script.json`. */
export async function runNarrate(options: RunNarrateOptions): Promise<NarrateOutcome> {
  const { review, config } = options;
  const checkOptions = { maxWordsPerStep: config.narration.maxWordsPerStep };

  // The last draft the model got as far as, kept so a failure leaves something to edit.
  let draft: NarrationScript | undefined;
  const check = (value: unknown): string[] => {
    const script = assembleScript(value as NarratorAnswer, review, config);
    draft = script;
    return checkScript(script, review, checkOptions);
  };

  let result;
  try {
    result = await runAgent({
      stage: "narrate",
      provider: options.provider,
      system: buildNarratorPrompt(),
      messages: [{ role: "user", content: [{ type: "text", text: describeReview(review) }] }],
      outputSchema: narratorOutputSchema(review),
      budget: options.budget,
      tracer: options.tracer,
      check,
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      maxOutputTokens: config.budgets.outputTokens,
      temperature: config.llm.temperature,
      maxRetries: config.llm.maxRetries,
    });
  } catch (error) {
    if (!(error instanceof StageError)) throw error;
    throw handOver(error.message, draft, options.runDir, error);
  }

  if (result.value === undefined) {
    throw handOver(
      `the model produced no narration (${result.stopped ?? "no answer"})`,
      draft,
      options.runDir,
    );
  }

  const script = assembleScript(result.value as NarratorAnswer, review, config);
  assertContract("script", script);
  return { script, attempts: result.attempts };
}

/**
 * Turns a failure into one a person can act on: the draft is written next to the run so it can
 * be finished by hand, and the message names both ways back into the pipeline. A stage boundary
 * is a file, so an edited `script.json` resumes the run exactly where this stopped.
 */
function handOver(
  reason: string,
  draft: NarrationScript | undefined,
  runDir: string,
  cause?: unknown,
): StageError {
  let next = "No draft got far enough to keep.";
  if (draft !== undefined) {
    const saved = path.join(runDir, REJECTED_SCRIPT_FILE);
    writeFileSync(saved, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    next =
      `The draft is in ${saved}: fix the lines named above, save it as ${SCRIPT_FILE}, and ` +
      `confirm it with \`spr validate ${SCRIPT_FILE}\`.`;
  }

  return new StageError(
    "narrate",
    `${reason}\n${next}\nOr change a budget, docs/NARRATION_STYLE.md or the model and re-run ` +
      `\`spr stage narrate --run ${runDir}\`.`,
    cause === undefined ? {} : { cause },
  );
}

/**
 * Reads and validates an existing `script.json`, the TTS stage's only input.
 *
 * It goes through the file rather than through memory on purpose, so `spr run` and
 * `spr stage tts` follow exactly the same path - and so does a `script.json` a person
 * finished by hand after a rejected draft (ADR-024).
 */
export function readScript(runDir: string): NarrationScript {
  const file = path.join(runDir, SCRIPT_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new StageError("tts", `Cannot read ${file}`, { cause });
  }
  const result = validateContract("script", parsed);
  if (!result.ok) throw new ContractError(file, result.errors);
  return result.value;
}

/** Writes `script.json` into a run folder. */
export function writeScript(runDir: string, script: NarrationScript): void {
  writeFileSync(path.join(runDir, SCRIPT_FILE), `${JSON.stringify(script, null, 2)}\n`, "utf8");
}

/** One line such as `script: 5 steps, about 84 seconds`. */
export function summarizeNarrate(outcome: NarrateOutcome): string {
  const steps = outcome.script.steps;
  const seconds = Math.round(steps.reduce((sum, s) => sum + (s.estimated_seconds ?? 0), 0));
  const line = `script: ${steps.length} steps, about ${seconds} seconds`;
  return outcome.attempts === 0 ? line : `${line} (${outcome.attempts} repaired)`;
}
