import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Budget } from "../../src/harness/budget.js";
import {
  FileLlmCache,
  NullCache,
  createCache,
  llmCacheKey,
  writeOnly,
  type LlmCache,
} from "../../src/harness/cache.js";
import { Tracer, type TraceEntry } from "../../src/harness/tracing.js";
import { ToolRegistry, MAX_TOOL_RESULT_CHARS } from "../../src/harness/tools.js";
import { FakeLlmProvider, fakeText } from "../../src/providers/llm/fake.js";
import {
  ZERO_USAGE,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from "../../src/providers/llm/types.js";
import { defaultConfig } from "../helpers.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spr-harness-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const REQUEST: LlmRequest = {
  system: "sys",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  outputSchema: { type: "object" },
  maxOutputTokens: 100,
  temperature: 0,
};

const usage = (over: Partial<LlmUsage> = {}): LlmUsage => ({ ...ZERO_USAGE, ...over });

describe("Budget", () => {
  const limits = defaultConfig().budgets;

  it("has room to begin with", () => {
    expect(new Budget(limits).exceeded()).toBeNull();
  });

  it.each([
    [
      "inputTokens",
      (b: Budget) => {
        b.addUsage(usage({ inputTokens: limits.inputTokens }));
      },
    ],
    [
      "outputTokens",
      (b: Budget) => {
        b.addUsage(usage({ outputTokens: limits.outputTokens }));
      },
    ],
    [
      "toolCalls",
      (b: Budget) => {
        b.addToolCall(limits.toolCalls);
      },
    ],
    [
      "agentSteps",
      (b: Budget) => {
        for (let i = 0; i < limits.agentSteps; i += 1) b.addStep();
      },
    ],
  ])("reports %s when it is used up", (name, spend) => {
    const budget = new Budget(limits);
    spend(budget);
    expect(budget.exceeded()).toBe(name);
  });

  it("reports wall clock without making the test wait", () => {
    let clock = 0;
    const budget = new Budget(limits, { now: () => clock });
    expect(budget.exceeded()).toBeNull();
    clock = limits.wallClockSeconds * 1000;
    expect(budget.exceeded()).toBe("wallClockSeconds");
  });

  it("accumulates spend across calls", () => {
    const budget = new Budget(limits);
    budget.addUsage(usage({ inputTokens: 10, outputTokens: 3 }));
    budget.addUsage(usage({ inputTokens: 5 }));
    budget.addToolCall();
    expect(budget.spend().usage).toMatchObject({ inputTokens: 15, outputTokens: 3 });
    expect(budget.spend().toolCalls).toBe(1);
  });
});

describe("llmCacheKey", () => {
  const provider = new FakeLlmProvider([]);

  it("is stable for the same request", () => {
    expect(llmCacheKey(provider, REQUEST)).toBe(llmCacheKey(provider, REQUEST));
  });

  it.each([
    ["system", { ...REQUEST, system: "other" }],
    ["temperature", { ...REQUEST, temperature: 0.5 }],
    ["schema", { ...REQUEST, outputSchema: { type: "array" } }],
    ["max tokens", { ...REQUEST, maxOutputTokens: 200 }],
    [
      "tools",
      { ...REQUEST, tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] },
    ],
  ])("changes when the %s changes", (_what, changed) => {
    expect(llmCacheKey(provider, changed)).not.toBe(llmCacheKey(provider, REQUEST));
  });

  it("changes when the model changes", () => {
    const other = new FakeLlmProvider([], { model: "other-model" });
    expect(llmCacheKey(other, REQUEST)).not.toBe(llmCacheKey(provider, REQUEST));
  });
});

describe("writeOnly", () => {
  it("records an answer without ever serving one", () => {
    const inner = new Map<string, LlmResponse>();
    const backing: LlmCache = {
      get: (key) => inner.get(key),
      set: (key, value) => {
        inner.set(key, value);
      },
    };
    const answer = fakeText("hello");

    const cache = writeOnly(backing);
    cache.set("k", answer);

    // A cold measurement must not be handed a stale answer...
    expect(cache.get("k")).toBeUndefined();
    // ...but the fresh one is kept, so re-scoring it later costs nothing.
    expect(backing.get("k")).toBe(answer);
  });
});

describe("FileLlmCache", () => {
  it("round-trips a response", () => {
    const cache = new FileLlmCache(tempDir());
    const response = fakeText("hello");
    expect(cache.get("k1")).toBeUndefined();
    cache.set("abc123", response);
    expect(cache.get("abc123")).toEqual(response);
  });

  it("treats a corrupt entry as a miss rather than an error", () => {
    const dir = tempDir();
    const cache = new FileLlmCache(dir);
    cache.set("deadbeef", fakeText("x"));
    const file = path.join(dir, "llm", "de", "deadbeef.json");
    writeFileSync(file, "{ not json", "utf8");
    expect(cache.get("deadbeef")).toBeUndefined();
  });

  it("survives a directory it cannot write to", () => {
    const cache = new FileLlmCache("/dev/null/nope");
    expect(() => {
      cache.set("k", fakeText("x"));
    }).not.toThrow();
    expect(cache.get("k")).toBeUndefined();
  });

  it("createCache honours cache.enabled", () => {
    expect(createCache({ enabled: false, dir: tempDir() })).toBeInstanceOf(NullCache);
    expect(createCache({ enabled: true, dir: tempDir() })).toBeInstanceOf(FileLlmCache);
  });
});

describe("Tracer", () => {
  type LlmEntry = Extract<TraceEntry, { kind: "llm_call" }>;
  const llmEntry = (over: Partial<LlmEntry> = {}): LlmEntry => ({
    kind: "llm_call",
    stage: "review",
    step: 1,
    provider: "ollama",
    model: "qwen3:30b",
    promptHash: "abc",
    cached: false,
    usage: usage({ inputTokens: 100, outputTokens: 50 }),
    costUsd: 0.5,
    durationMs: 10,
    stopReason: "end_turn",
    ...over,
  });

  it("writes one JSON line per entry", () => {
    const dir = tempDir();
    const tracer = new Tracer(dir);
    tracer.write(llmEntry());
    tracer.write({ kind: "stopped", stage: "review", step: 2, reason: "budget:agentSteps" });

    const lines = readFileSync(path.join(dir, "trace.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ kind: "llm_call", model: "qwen3:30b" });
  });

  it("totals usage and cost, and ignores cache hits", () => {
    const tracer = new Tracer();
    tracer.write(llmEntry());
    tracer.write(llmEntry({ cached: true, costUsd: 0 }));
    expect(tracer.cost()).toMatchObject({
      usage: usage({ inputTokens: 100, outputTokens: 50 }),
      costUsd: 0.5,
      llmCalls: 2,
      toolCalls: 0,
    });
  });

  it("breaks the run down by stage, counting a cached call's size but not its spend (step 3)", () => {
    const tracer = new Tracer();
    tracer.write(llmEntry({ durationMs: 1500 }));
    tracer.write(llmEntry({ cached: true, costUsd: 0, durationMs: 0 }));
    tracer.write(llmEntry({ stage: "narrate", usage: usage({ inputTokens: 7, outputTokens: 9 }) }));
    tracer.write({
      kind: "tool_call",
      stage: "review",
      step: 2,
      tool: "get_diff_hunk",
      input: {},
      ok: true,
      durationMs: 500,
      preview: "",
    });

    const { stages, usage: spent } = tracer.cost();
    // The cached call is work the stage did, so it is in the stage's tokens...
    expect(stages.review).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      llmCalls: 2,
      cachedCalls: 1,
      toolCalls: 1,
      seconds: 2,
    });
    expect(stages.narrate?.outputTokens).toBe(9);
    // ...but not in what the run spent.
    expect(spent.inputTokens).toBe(107);
  });

  it("reports the total as unknown when any model had no price", () => {
    const tracer = new Tracer();
    tracer.write(llmEntry());
    tracer.write(llmEntry({ costUsd: null }));
    expect(tracer.cost().costUsd).toBe("unknown");
  });

  it("writes cost.json", () => {
    const dir = tempDir();
    const tracer = new Tracer(dir);
    tracer.write(llmEntry());
    tracer.writeCost(dir);
    const cost = JSON.parse(readFileSync(path.join(dir, "cost.json"), "utf8")) as {
      costUsd: number;
    };
    expect(cost.costUsd).toBe(0.5);
  });

  it("never lets a bad trace path fail a run", () => {
    const tracer = new Tracer("/dev/null/nope");
    expect(() => {
      tracer.write(llmEntry());
    }).not.toThrow();
  });
});

describe("ToolRegistry", () => {
  const echo = {
    definition: {
      name: "echo",
      description: "Returns what it is given",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } },
      },
    },
    run: (input: Record<string, unknown>) => String(input.text),
  };

  it("runs a registered tool", async () => {
    const registry = new ToolRegistry([echo]);
    expect(registry.definitions().map((d) => d.name)).toEqual(["echo"]);
    const outcome = await registry.dispatch("echo", { text: "hello" });
    expect(outcome).toMatchObject({ content: "hello", isError: false });
  });

  it("rejects arguments that do not match the schema, without throwing", async () => {
    const registry = new ToolRegistry([echo]);
    const outcome = await registry.dispatch("echo", { wrong: 1 });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("Invalid arguments for echo");
  });

  it("names the available tools when the model invents one", async () => {
    const registry = new ToolRegistry([echo]);
    const outcome = await registry.dispatch("nope", {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("Available tools: echo");
  });

  it("turns a throwing handler into an error result the model can recover from", async () => {
    const registry = new ToolRegistry([
      {
        definition: { name: "boom", description: "fails", inputSchema: { type: "object" } },
        run: () => {
          throw new Error("disk on fire");
        },
      },
    ]);
    const outcome = await registry.dispatch("boom", {});
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.content).toContain("disk on fire");
  });

  it("truncates a result that would swamp the context window", async () => {
    const registry = new ToolRegistry([
      {
        definition: { name: "big", description: "lots", inputSchema: { type: "object" } },
        run: () => "x".repeat(MAX_TOOL_RESULT_CHARS * 2),
      },
    ]);
    const outcome = await registry.dispatch("big", {});
    expect(outcome.content.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100);
    expect(outcome.content).toContain("truncated");
  });

  it("refuses two tools with the same name", () => {
    expect(() => new ToolRegistry([echo, echo])).toThrow(/registered twice/);
  });
});
