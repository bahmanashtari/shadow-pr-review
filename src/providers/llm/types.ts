/**
 * A provider-neutral view of a chat model.
 *
 * These types deliberately are not the Anthropic SDK's. ADR-015 makes a local Ollama model
 * the default and the only provider a normal run needs, so nothing above this file may
 * depend on one vendor's shapes; `anthropic.ts` maps to the SDK at its own edge.
 */

/** Plain text produced by the model or sent to it. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** The model asking for a tool to be run. */
export interface ToolUseBlock {
  type: "tool_use";
  /** Correlates with the `tool_use_id` of the result sent back. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The answer to one {@link ToolUseBlock}. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  /** True when the tool failed; the model is expected to recover rather than stop. */
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** One turn of the conversation. */
export interface LlmMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** A read-only tool offered to the model, described by JSON Schema (ADR-011). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Token counts for one call. Cache fields are 0 for providers without prompt caching. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to a prompt cache, billed above the normal input rate. */
  cacheCreationInputTokens: number;
  /** Tokens served from a prompt cache, billed well below the normal input rate. */
  cacheReadInputTokens: number;
}

/** An empty usage record, the starting point for any total. */
export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Adds two usage records. */
export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/** Everything a provider needs for one call. Also the input to the cache key. */
export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDefinition[];
  /**
   * JSON Schema the final answer must satisfy. Ollama constrains decoding with it, so
   * conformance comes from the provider rather than from retries (ADR-015).
   */
  outputSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  temperature: number;
  /**
   * Seeds the sampler, so a run above temperature 0 can be repeated (ADR-059). Absent in an
   * ordinary run, which is greedy and has nothing to seed. Ollama honours it; the Anthropic
   * Messages API has no such parameter, so there it only keeps the cache entries apart.
   */
  seed?: number;
}

/** Why the model stopped. `tool_use` means the loop must run tools and call again. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

/** One completion. */
export interface LlmResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: LlmUsage;
}

/** Providers the config may select. */
export type LlmProviderName = "ollama" | "anthropic" | "fake";

/** A chat model the harness can drive. */
export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  /** Context limit of this model in tokens; budgets are checked against it (ADR-015). */
  readonly contextTokens: number;
  /**
   * True when constraining the answer to a schema makes a tool call impossible, as on Ollama:
   * the grammar only admits the answer, so a model offered tools can never call one (ADR-060).
   * The loop then offers tools unconstrained and asks for the answer in a call of its own.
   */
  readonly schemaSilencesTools: boolean;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
  /**
   * Cost of a call in USD, or null when this model's price is unknown.
   * Never guess zero for a hosted model: `cost.json` says "unknown" instead.
   */
  estimateCostUsd(usage: LlmUsage): number | null;
}

/** Concatenates the text blocks of a response, which is where a final answer lives. */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Every tool the model asked for in a response. */
export function toolUsesOf(content: readonly ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}
