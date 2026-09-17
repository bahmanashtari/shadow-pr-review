import { describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  anthropicModelInfo,
  type AnthropicLike,
} from "../../src/providers/llm/anthropic.js";
import { createProvider } from "../../src/providers/llm/create.js";
import { FakeLlmProvider, fakeText } from "../../src/providers/llm/fake.js";
import {
  OllamaProvider,
  ollamaContextTokens,
  toOllamaMessages,
} from "../../src/providers/llm/ollama.js";
import { textOf, ZERO_USAGE, type LlmRequest } from "../../src/providers/llm/types.js";
import { reviewerOutputSchema } from "../../src/agents/reviewer.js";
import {
  assembleScript,
  narratorOutputSchema,
  type NarratorAnswer,
} from "../../src/agents/narrator.js";
import { checkScript } from "../../src/contracts/checks.js";
import { assertContract } from "../../src/contracts/validate.js";
import { StageError } from "../../src/lib/errors.js";
import { defaultConfig, GOLDEN_SAMPLES, readGoldenJson } from "../helpers.js";

const REQUEST: LlmRequest = {
  system: "You review code.",
  messages: [{ role: "user", content: [{ type: "text", text: "Review this." }] }],
  tools: [],
  outputSchema: { type: "object" },
  maxOutputTokens: 2048,
  temperature: 0,
};

/** A fetch stub that returns one Ollama chat response. */
function ollamaFetch(body: unknown, ok = true): typeof fetch {
  const response = {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
  return () => Promise.resolve(response);
}

describe("ollamaContextTokens", () => {
  it.each([
    ["qwen3:30b", 262_144],
    ["qwen3-coder:30b", 262_144],
    ["mistral-small3.2:latest", 131_072],
    ["something-unknown:7b", 32_768],
  ])("%s -> %i", (model, expected) => {
    expect(ollamaContextTokens(model)).toBe(expected);
  });
});

describe("OllamaProvider", () => {
  it("disables thinking, constrains decoding and sets the context size", () => {
    const provider = new OllamaProvider({ model: "qwen3:30b", baseUrl: "http://localhost:11434" });
    const body = provider.buildBody(REQUEST);

    expect(body.think).toBe(true);
    expect(body.stream).toBe(false);
    expect(body.format).toEqual({ type: "object" });
    expect(body.options).toEqual({ temperature: 0, num_ctx: 32_768 });
    expect(body.tools).toBeUndefined();
  });

  it("thinks by default and can be told not to", () => {
    // ADR-021: thinking is equal on recall and better on grounding, at 15x the wall clock.
    const on = new OllamaProvider({ model: "qwen3:30b", baseUrl: "http://x" });
    const off = new OllamaProvider({ model: "qwen3:30b", baseUrl: "http://x", think: false });
    expect(on.buildBody(REQUEST).think).toBe(true);
    expect(off.buildBody(REQUEST).think).toBe(false);
  });

  it("clamps the allocated context to what the model supports", () => {
    const provider = new OllamaProvider({
      model: "unknown-model",
      baseUrl: "http://x",
      numCtx: 999_999,
    });
    expect((provider.buildBody(REQUEST).options as { num_ctx: number }).num_ctx).toBe(32_768);
  });

  it("sends tools in Ollama's function shape", () => {
    const provider = new OllamaProvider({ model: "qwen3:30b", baseUrl: "http://x" });
    const body = provider.buildBody({
      ...REQUEST,
      tools: [
        { name: "get_diff_hunk", description: "Reads a hunk", inputSchema: { type: "object" } },
      ],
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_diff_hunk",
          description: "Reads a hunk",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  it("reads text, tool calls and token counts out of a response", async () => {
    const provider = new OllamaProvider({
      model: "qwen3:30b",
      baseUrl: "http://x",
      fetchImpl: ollamaFetch({
        message: {
          content: "",
          tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }],
        },
        done_reason: "stop",
        prompt_eval_count: 120,
        eval_count: 30,
      }),
    });

    const response = await provider.complete(REQUEST);
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "tool_use", id: "read_file_0", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(response.usage).toEqual({
      ...ZERO_USAGE,
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(provider.estimateCostUsd()).toBe(0);
  });

  it("explains a server that is not running", async () => {
    const provider = new OllamaProvider({
      model: "qwen3:30b",
      baseUrl: "http://x",
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(provider.complete(REQUEST)).rejects.toThrow(/ollama serve/);
  });

  it("reports a non-200 with the model name", async () => {
    const provider = new OllamaProvider({
      model: "qwen3:30b",
      baseUrl: "http://x",
      fetchImpl: ollamaFetch("model not found", false),
    });
    await expect(provider.complete(REQUEST)).rejects.toThrow(/qwen3:30b/);
  });

  it("drops thinking and retries when the model cannot think, then stops asking", async () => {
    // Found by `spr eval --model qwen3-coder:30b`: ADR-021 turns thinking on for everyone, and
    // a model that cannot think would otherwise be unusable rather than merely slower.
    const bodies: { think?: unknown }[] = [];
    const fetchImpl = ((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { think?: unknown };
      bodies.push(body);
      if (body.think === true) {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve(JSON.stringify({ error: '"m" does not support thinking' })),
          json: () => Promise.resolve({}),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ message: { content: "done" }, done_reason: "stop" }),
        text: () => Promise.resolve(""),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({ model: "m", baseUrl: "http://x", fetchImpl });

    expect((await provider.complete(REQUEST)).content).toEqual([{ type: "text", text: "done" }]);
    expect(bodies.map((b) => b.think)).toEqual([true, false]);

    // The refusal is remembered, so the second call never asks again.
    await provider.complete(REQUEST);
    expect(bodies.map((b) => b.think)).toEqual([true, false, false]);
  });

  it("does not retry a refusal that has nothing to do with thinking", async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("model not found"),
        json: () => Promise.resolve({}),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({ model: "m", baseUrl: "http://x", fetchImpl });
    await expect(provider.complete(REQUEST)).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });
});

describe("toOllamaMessages", () => {
  it("flattens blocks and gives every tool result its own message", () => {
    expect(
      toOllamaMessages("sys", [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "contents" }],
        },
      ]),
    ).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "read_file", arguments: { path: "a" } } }],
      },
      { role: "tool", content: "contents", tool_name: "t1" },
    ]);
  });
});

describe("AnthropicProvider", () => {
  const client = (message: unknown): AnthropicLike => ({
    messages: {
      create: vi.fn(() => Promise.resolve(message)) as AnthropicLike["messages"]["create"],
    },
  });

  it("omits temperature for models that reject it, and sends it for those that accept", () => {
    const opus = new AnthropicProvider({ model: "claude-opus-5", client: client({}) });
    const haiku = new AnthropicProvider({ model: "claude-haiku-4-5", client: client({}) });

    // Opus 5 and Sonnet 5 return a 400 when temperature is present, which is why the SDK
    // marks the field deprecated. Reading it here is exactly what the test is for.
    /* eslint-disable @typescript-eslint/no-deprecated */
    expect(opus.buildParams(REQUEST).temperature).toBeUndefined();
    expect(haiku.buildParams(REQUEST).temperature).toBe(0);
    /* eslint-enable @typescript-eslint/no-deprecated */
  });

  it("caches the system prompt and asks for the schema and effort", () => {
    const provider = new AnthropicProvider({
      model: "claude-opus-5",
      client: client({}),
      effort: "max",
    });
    const params = provider.buildParams(REQUEST);
    expect(params.system).toEqual([
      { type: "text", text: "You review code.", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.output_config).toEqual({
      effort: "max",
      format: { type: "json_schema", schema: { type: "object" } },
    });
  });

  it("defaults to xhigh effort", () => {
    const provider = new AnthropicProvider({ model: "claude-opus-5", client: client({}) });
    expect(provider.buildParams(REQUEST).output_config?.effort).toBe("xhigh");
  });

  it("prices a call, charging cache writes more and cache reads less", () => {
    const provider = new AnthropicProvider({ model: "claude-opus-5", client: client({}) });
    // $5 per million in, $25 per million out; writes 1.25x, reads 0.1x.
    const cost = provider.estimateCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 + 25 + 6.25 + 0.5, 6);
  });

  it("returns null rather than zero for a model with no published price", () => {
    const provider = new AnthropicProvider({ model: "claude-future-9", client: client({}) });
    expect(provider.estimateCostUsd({ ...ZERO_USAGE, inputTokens: 1000 })).toBeNull();
    expect(anthropicModelInfo("claude-future-9")).toBeUndefined();
  });

  it("refuses to construct without a key and points at the free default", () => {
    expect(() => new AnthropicProvider({ model: "claude-opus-5" })).toThrow(StageError);
    expect(() => new AnthropicProvider({ model: "claude-opus-5" })).toThrow(/local Ollama/);
  });
});

describe("createProvider", () => {
  it("builds the local provider the config asks for, with no key", () => {
    const provider = createProvider(defaultConfig(), {});
    expect(provider.name).toBe("ollama");
    expect(provider.model).toBe("qwen3:30b");
  });

  it("builds the hosted provider only when a key is present", () => {
    const config = defaultConfig();
    const hosted = { ...config, llm: { ...config.llm, provider: "anthropic" as const } };
    expect(() => createProvider(hosted, {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(createProvider(hosted, { anthropicApiKey: "sk-test" }).name).toBe("anthropic");
  });

  describe("the fake provider answers whichever stage is asking", () => {
    const config = {
      ...defaultConfig(),
      llm: { ...defaultConfig().llm, provider: "fake" as const },
    };

    async function answerFor(outputSchema: Record<string, unknown>): Promise<unknown> {
      const response = await createProvider(config, {}).complete({ ...REQUEST, outputSchema });
      return JSON.parse(textOf(response.content));
    }

    it("returns an empty but valid review", async () => {
      const answer = (await answerFor(reviewerOutputSchema(10))) as { findings: unknown[] };
      expect(answer.findings).toEqual([]);
    });

    it("returns one placeholder step per kept finding, passing the narration rules", async () => {
      const review = assertContract(
        "review",
        readGoldenJson(GOLDEN_SAMPLES[0] ?? "", "review.expected.json"),
      );
      const answer = (await answerFor(narratorOutputSchema(review))) as NarratorAnswer;

      expect(answer.steps.map((s) => s.finding_id)).toEqual(review.findings.map((f) => f.id));
      const script = assembleScript(answer, review, defaultConfig());
      expect(checkScript(script, review)).toEqual([]);
    });

    it("narrates nothing for a review with no findings, whose schema carries no items", async () => {
      const review = assertContract(
        "review",
        readGoldenJson(GOLDEN_SAMPLES[0] ?? "", "review.expected.json"),
      );
      const empty = { ...review, findings: [] };
      const answer = (await answerFor(narratorOutputSchema(empty))) as NarratorAnswer;

      expect(answer.steps).toEqual([]);
      expect(checkScript(assembleScript(answer, empty, defaultConfig()), empty)).toEqual([]);
    });
  });
});

describe("FakeLlmProvider", () => {
  it("replays scripted turns and records the requests", async () => {
    const provider = new FakeLlmProvider([fakeText("one"), fakeText("two")]);
    expect((await provider.complete(REQUEST)).content).toEqual([{ type: "text", text: "one" }]);
    expect((await provider.complete(REQUEST)).content).toEqual([{ type: "text", text: "two" }]);
    expect(provider.callCount).toBe(2);
    expect(provider.requests).toHaveLength(2);
  });

  it("fails loudly when a test scripts too few turns", async () => {
    const provider = new FakeLlmProvider([]);
    await expect(provider.complete(REQUEST)).rejects.toThrow(/ran out of scripted turns/);
  });
});
