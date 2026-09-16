/**
 * Per-run spending limits. CLAUDE.md: hitting a budget stops the agent and keeps partial,
 * valid results; it is not an error, because a review with three findings beats no review.
 */
import type { SprConfig } from "../contracts/generated/config.js";
import { addUsage, ZERO_USAGE, type LlmUsage } from "../providers/llm/types.js";

/** The limits a run can hit, named so the stop reason says which one it was. */
export type BudgetName = keyof SprConfig["budgets"];

/** What has been spent so far. */
export interface BudgetSpend {
  usage: LlmUsage;
  toolCalls: number;
  agentSteps: number;
  elapsedSeconds: number;
}

/** Options for {@link Budget}. */
export interface BudgetOptions {
  /** Monotonic clock in milliseconds; injected so tests do not wait. */
  now?: () => number;
}

/** Tracks spending against `config.budgets`. */
export class Budget {
  private readonly limits: SprConfig["budgets"];
  private readonly now: () => number;
  private readonly startedAt: number;
  private usage: LlmUsage = ZERO_USAGE;
  private toolCalls = 0;
  private agentSteps = 0;

  constructor(limits: SprConfig["budgets"], options: BudgetOptions = {}) {
    this.limits = limits;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  /** Records the cost of one model call. A cache hit must not be passed here. */
  addUsage(usage: LlmUsage): void {
    this.usage = addUsage(this.usage, usage);
  }

  /** Records one tool invocation. */
  addToolCall(count = 1): void {
    this.toolCalls += count;
  }

  /** Records one trip round the agent loop. */
  addStep(): void {
    this.agentSteps += 1;
  }

  /** Everything spent so far. */
  spend(): BudgetSpend {
    return {
      usage: this.usage,
      toolCalls: this.toolCalls,
      agentSteps: this.agentSteps,
      elapsedSeconds: (this.now() - this.startedAt) / 1000,
    };
  }

  /**
   * The first budget that is used up, or null when there is room left.
   * Checked before each call, so a run stops rather than overshooting.
   */
  exceeded(): BudgetName | null {
    const spend = this.spend();
    if (spend.usage.inputTokens >= this.limits.inputTokens) return "inputTokens";
    if (spend.usage.outputTokens >= this.limits.outputTokens) return "outputTokens";
    if (spend.toolCalls >= this.limits.toolCalls) return "toolCalls";
    if (spend.agentSteps >= this.limits.agentSteps) return "agentSteps";
    if (spend.elapsedSeconds >= this.limits.wallClockSeconds) return "wallClockSeconds";
    return null;
  }
}
