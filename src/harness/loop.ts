/**
 * The agent loop: call the model, run whatever tools it asks for, and keep going until it
 * answers. The answer is validated against its JSON Schema and, on failure, sent back with
 * the validation errors (CLAUDE.md: max two retries, then fail the stage clearly).
 *
 * Prompt injection: diff content only ever enters as `user` content. Nothing the model or a
 * tool returns is ever promoted into the system prompt.
 */
import { compileSchema } from "../contracts/validate.js";
import { StageError, type StageName } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import type { LlmCache } from "./cache.js";
import { llmCacheKey, NullCache } from "./cache.js";
import type { Budget } from "./budget.js";
import { Tracer } from "./tracing.js";
import type { ToolRegistry } from "./tools.js";
import {
  textOf,
  toolUsesOf,
  type ContentBlock,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "../providers/llm/types.js";

/** Input for {@link runAgent}. */
export interface RunAgentOptions {
  stage: StageName;
  provider: LlmProvider;
  /** Built from repository files only, never from diff or tool content. */
  system: string;
  messages: LlmMessage[];
  /** JSON Schema the answer must satisfy. Also constrains decoding on Ollama. */
  outputSchema: Record<string, unknown>;
  budget: Budget;
  tracer: Tracer;
  tools?: ToolRegistry;
  cache?: LlmCache;
  /** Extra cross-field rules, for example `checkReview`. */
  check?: (value: unknown) => string[];
  maxOutputTokens: number;
  temperature: number;
  /** Seeds the sampler; only `spr eval --seed` sets it (ADR-059). */
  seed?: number;
  /**
   * Make the tools reachable on a provider whose schema constraint would silence them, at the
   * price of one more call per answer (ADR-060). Worth it only when the tools can show what the
   * prompt does not - a checkout - so the Reviewer asks for it then and nothing else does.
   */
  lookBeforeAnswering?: boolean;
  /** Repair attempts after a failed validation. */
  maxRetries: number;
}

/** What the loop produced. */
export interface AgentResult {
  /** The validated answer, or undefined when a budget stopped the run first. */
  value: unknown;
  /** Null on success, otherwise why the loop gave up, for example `budget:agentSteps`. */
  stopped: string | null;
  steps: number;
  /** How many validation repairs were needed. */
  attempts: number;
}

/**
 * Pulls JSON out of a model answer, tolerating a ```json fence. Constrained decoding makes
 * this unnecessary on Ollama, but a hosted model occasionally wraps its output.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  return JSON.parse(candidate);
}

/** Runs one agent to a validated answer. */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { stage, budget, tracer, outputSchema } = options;
  const cache = options.cache ?? new NullCache();
  const tools = options.tools;
  const validate = compileSchema<unknown>(outputSchema);
  const messages: LlmMessage[] = options.messages.map((m) => ({ ...m, content: [...m.content] }));

  let steps = 0;
  let attempts = 0;

  for (;;) {
    const exceeded = budget.exceeded();
    if (exceeded !== null) {
      tracer.write({ kind: "stopped", stage, step: steps, reason: `budget:${exceeded}` });
      return { value: undefined, stopped: `budget:${exceeded}`, steps, attempts };
    }

    budget.addStep();
    steps += 1;

    // Where a schema constraint would silence the tools (Ollama, ADR-060), a turn that offers them
    // goes out unconstrained, so the model can look before it answers.
    const looksFirst =
      options.lookBeforeAnswering === true &&
      (tools?.size ?? 0) > 0 &&
      options.provider.schemaSilencesTools;
    const request: LlmRequest = {
      system: options.system,
      messages,
      tools: tools?.definitions() ?? [],
      ...(looksFirst ? {} : { outputSchema }),
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    };
    let response = await callModel(options, request, cache, steps);
    if (looksFirst && toolUsesOf(response.content).length === 0) {
      // Done looking. The unconstrained reply is set aside and the answer asked for exactly as it
      // always was - tools listed, schema enforced - so a model that read nothing is asked the
      // question it was always asked, and one that read something has it in the conversation.
      response = await callModel(options, { ...request, outputSchema }, cache, steps);
    }

    // The model wants tools: run them all, answer in one user message, and continue.
    const toolUses = toolUsesOf(response.content);
    if (toolUses.length > 0 && tools && tools.size > 0) {
      messages.push({ role: "assistant", content: response.content });
      const results: ContentBlock[] = [];
      for (const use of toolUses) {
        const outcome = await tools.dispatch(use.name, use.input);
        budget.addToolCall();
        tracer.write({
          kind: "tool_call",
          stage,
          step: steps,
          tool: use.name,
          input: use.input,
          ok: !outcome.isError,
          durationMs: outcome.durationMs,
          preview: Tracer.preview(outcome.content),
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = textOf(response.content);
    const problems = validateAnswer(text, validate, options.check);
    if (problems.length === 0) return { value: extractJson(text), stopped: null, steps, attempts };

    tracer.write({
      kind: "validation_failed",
      stage,
      step: steps,
      attempt: attempts + 1,
      errors: problems,
    });
    if (attempts >= options.maxRetries) {
      throw new StageError(
        stage,
        `The model's answer did not match ${schemaTitle(outputSchema)} after ` +
          `${attempts + 1} attempts:\n  - ${problems.join("\n  - ")}`,
      );
    }
    attempts += 1;
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            `That answer is not valid. Fix exactly these problems and reply with the ` +
            `corrected JSON only:\n- ${problems.join("\n- ")}`,
        },
      ],
    });
  }
}

/** The schema's title, for an error a person can act on. */
function schemaTitle(schema: Record<string, unknown>): string {
  return typeof schema.title === "string" ? schema.title : "the schema";
}

/** Calls the provider through the cache, tracing either way. */
async function callModel(
  options: RunAgentOptions,
  request: LlmRequest,
  cache: LlmCache,
  step: number,
): Promise<LlmResponse> {
  const { provider, budget, tracer, stage } = options;
  const key = llmCacheKey(provider, request);
  const promptHash = sha256(`${provider.model}:${request.system}`).slice(0, 16);

  const hit = cache.get(key);
  if (hit) {
    tracer.write({
      kind: "llm_call",
      stage,
      step,
      provider: provider.name,
      model: provider.model,
      promptHash,
      cached: true,
      usage: hit.usage,
      costUsd: 0,
      durationMs: 0,
      stopReason: hit.stopReason,
    });
    return hit;
  }

  const started = Date.now();
  const response = await provider.complete(request);
  // A cache hit costs nothing, so only a real call is charged to the budget.
  budget.addUsage(response.usage);
  cache.set(key, response);
  tracer.write({
    kind: "llm_call",
    stage,
    step,
    provider: provider.name,
    model: provider.model,
    promptHash,
    cached: false,
    usage: response.usage,
    costUsd: provider.estimateCostUsd(response.usage),
    durationMs: Date.now() - started,
    stopReason: response.stopReason,
  });
  return response;
}

/** Parses, schema-checks and cross-field-checks one answer. */
function validateAnswer(
  text: string,
  validate: (data: unknown) => { ok: true; value: unknown } | { ok: false; errors: string[] },
  check?: (value: unknown) => string[],
): string[] {
  if (text.trim() === "") return ["the answer was empty"];
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (error) {
    return [
      `the answer is not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    ];
  }
  const result = validate(parsed);
  if (!result.ok) return result.errors;
  return check ? check(parsed) : [];
}
