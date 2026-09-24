/**
 * A scripted provider for tests. CLAUDE.md forbids network calls in unit tests, so every
 * loop, budget, retry and cache test runs against this.
 */
import {
  ZERO_USAGE,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from "./types.js";

/** What a fake turn returns: a canned response, or a function of the request. */
export type FakeTurn = LlmResponse | ((request: LlmRequest, call: number) => LlmResponse);

/** Options for {@link FakeLlmProvider}. */
export interface FakeProviderOptions {
  model?: string;
  contextTokens?: number;
  /** USD per call, so cost accounting can be tested. Null means "price unknown". */
  costPerCallUsd?: number | null;
  /** Keep answering with the last turn instead of running out. */
  repeatLastTurn?: boolean;
  /** Behave like Ollama, whose schema constraint silences tools (ADR-060). Default false. */
  schemaSilencesTools?: boolean;
}

/** Builds a plain text response, the common case in tests. */
export function fakeText(text: string, usage: Partial<LlmUsage> = {}): LlmResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { ...ZERO_USAGE, inputTokens: 10, outputTokens: 5, ...usage },
  };
}

/** Builds a response asking for one tool. */
export function fakeToolUse(
  name: string,
  input: Record<string, unknown>,
  id = `tool_${name}`,
): LlmResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    usage: { ...ZERO_USAGE, inputTokens: 10, outputTokens: 5 },
  };
}

/** Replays scripted responses and records what it was asked. */
export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake" as const;
  readonly model: string;
  readonly contextTokens: number;
  readonly schemaSilencesTools: boolean;
  /** Every request this provider received, in order. */
  readonly requests: LlmRequest[] = [];

  private readonly turns: FakeTurn[];
  private readonly costPerCallUsd: number | null;
  private readonly repeatLastTurn: boolean;
  private call = 0;

  constructor(turns: readonly FakeTurn[], options: FakeProviderOptions = {}) {
    this.turns = [...turns];
    this.model = options.model ?? "fake-model";
    this.contextTokens = options.contextTokens ?? 100_000;
    this.costPerCallUsd = options.costPerCallUsd === undefined ? 0 : options.costPerCallUsd;
    this.repeatLastTurn = options.repeatLastTurn ?? false;
    this.schemaSilencesTools = options.schemaSilencesTools ?? false;
  }

  /** How many times the model was actually called (a cache hit never reaches here). */
  get callCount(): number {
    return this.call;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    const turn = this.turns[this.call] ?? (this.repeatLastTurn ? this.turns.at(-1) : undefined);
    if (turn === undefined) {
      return Promise.reject(
        new Error(`FakeLlmProvider ran out of scripted turns at call ${this.call + 1}`),
      );
    }
    this.requests.push(request);
    const response = typeof turn === "function" ? turn(request, this.call) : turn;
    this.call += 1;
    return Promise.resolve(response);
  }

  estimateCostUsd(): number | null {
    return this.costPerCallUsd;
  }
}
