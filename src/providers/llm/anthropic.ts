/**
 * The opt-in hosted provider. A normal run never reaches this file: the pipeline defaults
 * to a local Ollama model and needs no API key (ADR-015). This exists for whoever supplies
 * their own key and wants a frontier model for one run.
 */
import Anthropic from "@anthropic-ai/sdk";
import { StageError } from "../../lib/errors.js";
import {
  ZERO_USAGE,
  type ContentBlock,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
  type StopReason,
} from "./types.js";

/** How hard the model should work. Higher costs more and answers better. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface ModelInfo {
  contextTokens: number;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /**
   * Current Claude models reject `temperature` with a 400; only Haiku 4.5 and older take
   * it. `config.llm.temperature` is always set, so the adapter has to know which is which.
   */
  acceptsTemperature: boolean;
}

/** Prices and limits, checked against the Anthropic pricing reference (June 2026). */
const MODELS: Readonly<Record<string, ModelInfo>> = {
  "claude-opus-5": {
    contextTokens: 1_000_000,
    inputPerMTok: 5,
    outputPerMTok: 25,
    acceptsTemperature: false,
  },
  "claude-sonnet-5": {
    contextTokens: 1_000_000,
    inputPerMTok: 2,
    outputPerMTok: 10,
    acceptsTemperature: false,
  },
  "claude-haiku-4-5": {
    contextTokens: 200_000,
    inputPerMTok: 1,
    outputPerMTok: 5,
    acceptsTemperature: true,
  },
};

/** Cache writes cost more than plain input, cache reads far less. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Assumed context for a model that is not in the table. */
const DEFAULT_CONTEXT_TOKENS = 200_000;

/** What is known about a model, or undefined when it is not in the table. */
export function anthropicModelInfo(model: string): ModelInfo | undefined {
  return MODELS[model];
}

/** Minimal surface of the SDK client this provider uses, so tests can substitute one. */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** Options for {@link AnthropicProvider}. */
export interface AnthropicProviderOptions {
  model: string;
  apiKey?: string;
  /** Substituted in tests; built from `apiKey` otherwise. */
  client?: AnthropicLike;
  /** Reasoning effort. Defaults to `xhigh`, the best setting for coding work. */
  effort?: Effort;
}

function toContentParams(blocks: readonly ContentBlock[]): Anthropic.ContentBlockParam[] {
  return blocks.map((block): Anthropic.ContentBlockParam => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") {
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    }
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: block.content,
      ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
    };
  });
}

function toMessageParams(messages: readonly LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: toContentParams(m.content) }));
}

function fromStopReason(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** Calls the Anthropic Messages API. */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  /** Structured outputs constrain the final text only; tool calls pass through (ADR-060). */
  readonly schemaSilencesTools = false;
  readonly model: string;
  readonly contextTokens: number;

  private readonly client: AnthropicLike;
  private readonly info: ModelInfo | undefined;
  private readonly effort: Effort;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.info = anthropicModelInfo(options.model);
    this.contextTokens = this.info?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
    this.effort = options.effort ?? "xhigh";

    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.apiKey) {
        throw new StageError(
          "config",
          "ANTHROPIC_API_KEY is not set. The default provider is local Ollama and needs no key;" +
            " set SPR_LLM_PROVIDER=ollama, or export a key to use the hosted model.",
        );
      }
      this.client = new Anthropic({ apiKey: options.apiKey });
    }
  }

  /** Builds the request. Separate from {@link complete} so tests can assert on it. */
  buildParams(request: LlmRequest): Anthropic.MessageCreateParamsNonStreaming {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      // The rubric-built system prompt is identical on every run, so it is the cache prefix.
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: toMessageParams(request.messages),
      output_config: {
        effort: this.effort,
        ...(request.outputSchema
          ? { format: { type: "json_schema" as const, schema: request.outputSchema } }
          : {}),
      },
    };

    if (request.tools.length > 0) {
      params.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
        strict: true,
      }));
    }
    // Sending temperature to a model that rejects it is a 400, not a warning. The SDK marks
    // the field deprecated for exactly that reason; Haiku 4.5 and older still accept it, and
    // the table above is what decides. Remove this branch when those models are dropped.
    if (this.info?.acceptsTemperature === true) {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      params.temperature = request.temperature;
    }
    return params;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(this.buildParams(request));
    } catch (cause) {
      throw new StageError("review", describeError(cause, this.model), { cause });
    }

    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    const usage: LlmUsage = {
      ...ZERO_USAGE,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    };
    return { content, stopReason: fromStopReason(message.stop_reason), usage };
  }

  /** Null when the model is not in the price table: never report a hosted call as free. */
  estimateCostUsd(usage: LlmUsage): number | null {
    const info = this.info;
    if (!info) return null;
    const perToken = info.inputPerMTok / 1_000_000;
    return (
      usage.inputTokens * perToken +
      usage.cacheCreationInputTokens * perToken * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadInputTokens * perToken * CACHE_READ_MULTIPLIER +
      usage.outputTokens * (info.outputPerMTok / 1_000_000)
    );
  }
}

/** Turns an SDK error into one clear line, most specific case first. */
function describeError(cause: unknown, model: string): string {
  if (cause instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY was rejected.";
  if (cause instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached.";
  if (cause instanceof Anthropic.BadRequestError) {
    return `Anthropic rejected the request for ${model}: ${cause.message}`;
  }
  if (cause instanceof Anthropic.APIError) {
    return `Anthropic API error ${String(cause.status)} for ${model}: ${cause.message}`;
  }
  return `Anthropic call failed for ${model}: ${String(cause)}`;
}
