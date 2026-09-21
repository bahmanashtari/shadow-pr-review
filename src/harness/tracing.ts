/**
 * `trace.jsonl` and `cost.json`. Every model and tool call is recorded, so a bad review can
 * be explained after the fact and the CLI can point at one file when a stage fails.
 *
 * Secrets never reach here: the provider name and model are traced, the API key is not.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StageName } from "../lib/errors.js";
import { addUsage, ZERO_USAGE, type LlmUsage } from "../providers/llm/types.js";

/** One line of `trace.jsonl`. */
export type TraceEntry =
  | {
      kind: "llm_call";
      stage: StageName;
      step: number;
      provider: string;
      model: string;
      promptHash: string;
      cached: boolean;
      usage: LlmUsage;
      costUsd: number | null;
      durationMs: number;
      stopReason: string;
    }
  | {
      kind: "tool_call";
      stage: StageName;
      step: number;
      tool: string;
      input: unknown;
      ok: boolean;
      durationMs: number;
      /** Truncated result, enough to explain a finding without copying whole files. */
      preview: string;
    }
  | {
      kind: "validation_failed";
      stage: StageName;
      step: number;
      attempt: number;
      errors: string[];
    }
  | { kind: "stopped"; stage: StageName; step: number; reason: string };

/**
 * One stage's share of a run (roadmap step 3). Its tokens count cached calls too, because they say
 * how big the stage's work is - which is what a budget is measured against - while the run's
 * top-level `usage` says what this run actually spent. On a local model the seconds are the cost.
 */
export interface StageCost {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  cachedCalls: number;
  toolCalls: number;
  seconds: number;
}

/** How much of a tool result is kept in the trace. */
const PREVIEW_CHARS = 400;

/** Writes trace lines and accumulates the run's cost. */
export class Tracer {
  private readonly file: string | undefined;
  private usage: LlmUsage = ZERO_USAGE;
  private costUsd = 0;
  /** True once any call had an unknown price, so the total cannot be trusted. */
  private costUnknown = false;
  private calls = 0;
  private toolCalls = 0;
  private readonly stages = new Map<StageName, StageCost>();
  /** Kept in memory as well as on disk, so tests can assert without reading files. */
  readonly entries: TraceEntry[] = [];

  constructor(runDir?: string) {
    this.file = runDir === undefined ? undefined : path.join(runDir, "trace.jsonl");
  }

  /** Appends one entry and folds it into the running totals. */
  write(entry: TraceEntry): void {
    this.entries.push(entry);
    if (entry.kind === "llm_call") {
      this.calls += 1;
      // A cache hit cost nothing this time, so it is not added to the totals.
      if (!entry.cached) {
        this.usage = addUsage(this.usage, entry.usage);
        if (entry.costUsd === null) this.costUnknown = true;
        else this.costUsd += entry.costUsd;
      }
    }
    if (entry.kind === "tool_call") this.toolCalls += 1;
    if (entry.kind === "llm_call" || entry.kind === "tool_call") this.addToStage(entry);

    if (this.file !== undefined) {
      try {
        appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // Tracing must never be the reason a run fails.
      }
    }
  }

  private addToStage(entry: Extract<TraceEntry, { kind: "llm_call" | "tool_call" }>): void {
    const stage = this.stages.get(entry.stage) ?? {
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
      cachedCalls: 0,
      toolCalls: 0,
      seconds: 0,
    };
    if (entry.kind === "llm_call") {
      stage.llmCalls += 1;
      if (entry.cached) stage.cachedCalls += 1;
      stage.inputTokens += entry.usage.inputTokens;
      stage.outputTokens += entry.usage.outputTokens;
    } else {
      stage.toolCalls += 1;
    }
    stage.seconds = Math.round((stage.seconds * 1000 + entry.durationMs) / 100) / 10;
    this.stages.set(entry.stage, stage);
  }

  /** Shortens a tool result for the trace. */
  static preview(text: string): string {
    return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}...`;
  }

  /** The run's totals, with cost "unknown" when any model had no price. */
  cost(): {
    usage: LlmUsage;
    costUsd: number | "unknown";
    llmCalls: number;
    toolCalls: number;
    stages: Partial<Record<StageName, StageCost>>;
  } {
    return {
      usage: this.usage,
      costUsd: this.costUnknown ? "unknown" : this.costUsd,
      llmCalls: this.calls,
      toolCalls: this.toolCalls,
      stages: Object.fromEntries(this.stages),
    };
  }

  /** Writes `cost.json` next to the trace. */
  writeCost(runDir: string): void {
    writeFileSync(
      path.join(runDir, "cost.json"),
      `${JSON.stringify(this.cost(), null, 2)}\n`,
      "utf8",
    );
  }
}
