/**
 * The default provider (ADR-015): a local Ollama server, no API key, no cost.
 *
 * Two things here are measured rather than assumed (ADR-018): thinking is switched off,
 * because it made the reviewer produce fewer and worse findings at five to ten times the
 * wall clock, and the context limits come from what `ollama show` reports per model.
 */
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
  type ToolDefinition,
} from "./types.js";

/** Context window per model, from `ollama show`. Used for budget checks. */
const CONTEXT_TOKENS: Readonly<Record<string, number>> = {
  "qwen3-coder": 262_144,
  qwen3: 262_144,
  "mistral-small3.2": 131_072,
  "mistral-small": 131_072,
  devstral: 131_072,
  "gpt-oss": 131_072,
};

/** Assumed context for a model that is not in the table; deliberately conservative. */
const DEFAULT_CONTEXT_TOKENS = 32_768;

/** How much context to actually allocate. Full 256K would size the KV cache absurdly. */
const DEFAULT_NUM_CTX = 32_768;

/** Looks up a model's context window by its name, ignoring the `:tag` suffix. */
export function ollamaContextTokens(model: string): number {
  const base = model.split(":")[0] ?? model;
  return CONTEXT_TOKENS[base] ?? CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
}

/** Options for {@link OllamaProvider}. */
export interface OllamaProviderOptions {
  model: string;
  baseUrl: string;
  /** Injected so tests never open a socket (CLAUDE.md: no network in unit tests). */
  fetchImpl?: typeof fetch;
  /** Context to allocate for the request. Clamped to the model's limit. */
  numCtx?: number;
  /** Let the model think first. Default true (ADR-021): better grounding, 15x the time. */
  think?: boolean;
  timeoutMs?: number;
}

interface OllamaToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

interface OllamaChatResponse {
  message?: { content?: unknown; tool_calls?: OllamaToolCall[] };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Ollama speaks flat messages, so content blocks are flattened into its shape. */
export function toOllamaMessages(
  system: string,
  messages: readonly LlmMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system !== "") out.push({ role: "system", content: system });

  for (const message of messages) {
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolUses = message.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    const toolResults = message.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
    );

    // A tool result is its own message in Ollama's protocol, never part of a user turn.
    for (const result of toolResults) {
      out.push({ role: "tool", content: result.content, tool_name: result.tool_use_id });
    }
    if (text !== "" || toolUses.length > 0) {
      const entry: Record<string, unknown> = { role: message.role, content: text };
      if (toolUses.length > 0) {
        entry.tool_calls = toolUses.map((u) => ({
          function: { name: u.name, arguments: u.input },
        }));
      }
      out.push(entry);
    }
  }
  return out;
}

/** Ollama wants JSON Schema under `function.parameters`. */
export function toOllamaTools(tools: readonly ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

/** Calls a local Ollama server over its chat API. */
export class OllamaProvider implements LlmProvider {
  readonly name = "ollama" as const;
  readonly model: string;
  readonly contextTokens: number;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly numCtx: number;
  private readonly think: boolean;
  private readonly timeoutMs: number;

  constructor(options: OllamaProviderOptions) {
    this.model = options.model;
    this.contextTokens = ollamaContextTokens(options.model);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.numCtx = Math.min(options.numCtx ?? DEFAULT_NUM_CTX, this.contextTokens);
    this.think = options.think ?? true;
    this.timeoutMs = options.timeoutMs ?? 600_000;
  }

  /** Builds the request body. Exported through the class so tests can assert on it. */
  buildBody(request: LlmRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: false,
      // ADR-021: on the final prompt, thinking is equal on recall and better on grounding,
      // at 15x the wall clock. Affordable because TTS and rendering dominate a run.
      think: this.think,
      messages: toOllamaMessages(request.system, request.messages),
      options: { temperature: request.temperature, num_ctx: this.numCtx },
    };
    if (request.tools.length > 0) body.tools = toOllamaTools(request.tools);
    // Constrained decoding: the schema is enforced by the provider, not by retries.
    if (request.outputSchema) body.format = request.outputSchema;
    return body;
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          controller.abort();
        },
        { once: true },
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.buildBody(request)),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new StageError(
        "review",
        `Cannot reach Ollama at ${this.baseUrl}. Is "ollama serve" running?`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new StageError(
        "review",
        `Ollama returned ${response.status} for model ${this.model}: ${detail.slice(0, 500)}`,
      );
    }

    const json = (await response.json()) as OllamaChatResponse;
    return this.toResponse(json);
  }

  private toResponse(json: OllamaChatResponse): LlmResponse {
    const content: ContentBlock[] = [];
    const text = typeof json.message?.content === "string" ? json.message.content : "";
    if (text !== "") content.push({ type: "text", text });

    const calls = Array.isArray(json.message?.tool_calls) ? json.message.tool_calls : [];
    calls.forEach((call, i) => {
      const name = typeof call.function?.name === "string" ? call.function.name : "";
      if (name === "") return;
      const raw = call.function?.arguments;
      const input =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      // Ollama does not issue call ids; the name plus position is stable within a turn.
      content.push({ type: "tool_use", id: `${name}_${i}`, name, input });
    });

    const usage: LlmUsage = {
      ...ZERO_USAGE,
      inputTokens: asNumber(json.prompt_eval_count),
      outputTokens: asNumber(json.eval_count),
    };
    return { content, stopReason: stopReasonOf(json.done_reason, calls.length > 0), usage };
  }

  /** Local inference is free. */
  estimateCostUsd(): number {
    return 0;
  }
}

function stopReasonOf(doneReason: unknown, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  if (doneReason === "length") return "max_tokens";
  if (doneReason === "stop") return "end_turn";
  return "other";
}
