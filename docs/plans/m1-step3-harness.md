# Plan: Milestone 1, step 3 (Harness)

Status: draft, awaiting approval. Read CLAUDE.md, docs/ROADMAP.md, docs/ARCHITECTURE.md
(section "2. Reviewer agent") and docs/DECISIONS.md (ADR-002, ADR-011, ADR-015) first.

This step builds the machinery the three agents run on. It adds no prompts and no agent:
the Reviewer arrives in step 4. Everything here is exercised by a fake provider and fake
tools, so the whole step is testable without a network or a model.

Contract note: this step introduces no file in `schemas/`. It does need one addition to
`config/config.schema.json` (section 9) and it surfaces one existing contract conflict
(open question 1). Neither is changed without approval.

## 1. Scope

In:
- `LlmProvider` interface with three implementations: Ollama (default, ADR-015), Anthropic
  (opt-in), and a fake for tests.
- A provider-neutral tool-use loop with JSON Schema validation and up to `llm.maxRetries`
  repair attempts.
- Budgets (input tokens, output tokens, tool calls, agent steps, wall clock).
- `trace.jsonl` and `cost.json` in the run folder.
- An on-disk LLM response cache.

Out (later steps): the Reviewer/Verifier/Narrator prompts and the four read-only diff tools
(step 4), the deterministic verifier (step 5), `spr eval` (step 7).

## 2. Dependencies

`pnpm add @anthropic-ai/sdk`. Nothing for Ollama: it is a plain JSON HTTP API and the
injected `fetch` (section 4) is what makes it testable.

If the install asks for a new build approval in `pnpm-workspace.yaml`, tell me which package
and why before approving.

## 3. Provider interface (`src/providers/llm/types.ts`)

Neutral types, not the Anthropic SDK's. The SDK's types are normally the right thing to
reuse, but ADR-015 makes a local model the default, so the loop cannot depend on one
vendor's shapes. `anthropic.ts` maps neutral -> SDK at its edge; nothing above it sees
`Anthropic.*`.

```ts
export type Role = "user" | "assistant";
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number; // billed at ~1.25x
  cacheReadInputTokens: number;     // billed at ~0.1x
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDefinition[];
  /** JSON Schema the final answer must satisfy. Ollama constrains decoding with it. */
  outputSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  temperature: number;
}

export interface LlmResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: "ollama" | "anthropic" | "fake";
  readonly model: string;
  /** Context limit of this model in tokens (ADR-015 requires this per provider). */
  readonly contextTokens: number;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
  /** USD, or null when the model's price is not in the table. Never guess 0. */
  estimateCostUsd(usage: LlmUsage): number | null;
}
```

`LlmUsage` carries the two cache fields because prompt caching is the main cost lever for
the Reviewer (section 5) and `cost.json` is wrong without them.

`estimateCostUsd` returns `number | null` on purpose: a hosted model whose price is missing
from the table must report "unknown", not "$0.00". Local providers return a real 0.

`createProvider(config, secrets)` in `src/providers/llm/create.ts` picks the implementation
and fails with a `StageError` when `anthropic` is selected without `ANTHROPIC_API_KEY`.

## 4. Ollama provider (`src/providers/llm/ollama.ts`)

- `POST {llm.baseUrl}/api/chat`, `stream: false`.
- `format` takes the output JSON Schema, which constrains decoding (ADR-015): conformance
  comes from the provider, not from retries.
- `options: { temperature, num_ctx }`; `tools` for tool calling.
- `think: false`. Measured on the golden set (ADR-018), thinking made `qwen3:30b` produce
  fewer findings, miss two of four labelled issues, and cost 5 to 10 times the wall clock.
- Usage from `prompt_eval_count` and `eval_count`; both cache fields 0.
- `estimateCostUsd` returns 0.
- `contextTokens` from a small table keyed by model name, read from the values `ollama show`
  reports: `qwen3:30b` and `qwen3:4b` 262144, `mistral-small3.2` 131072. An unknown model
  defaults to a conservative 32768, and the chosen value is written to the trace so a wrong
  guess is visible.
- The provider takes `fetchImpl: typeof fetch` (default `globalThis.fetch`), so tests drive
  it with a stub and never open a socket.

## 5. Anthropic provider (`src/providers/llm/anthropic.ts`)

Uses `@anthropic-ai/sdk` (`new Anthropic({ apiKey })`), typed errors checked most-specific
first (`RateLimitError` -> `APIError`). Two things that are easy to get wrong and are
pinned by tests:

- **`temperature` must be omitted for current Claude models.** Opus 5, Sonnet 5 and the
  4.7/4.8 family reject `temperature` with a 400; only Haiku 4.5 and older accept it.
  `config.llm.temperature` is 0, so a run with `SPR_LLM_MODEL=claude-opus-5` would fail
  today. The adapter sends `temperature` only for models whose table entry allows it.
- **Prompt caching is on.** Render order is `tools` -> `system` -> `messages`, so the
  rubric-derived system prompt and the tool list are the stable prefix and get
  `cache_control: { type: "ephemeral" }`; the diff goes last, in a user message. The
  Reviewer's system prompt is identical on every run, so this is the cheapest real saving
  available, and `usage.cache_read_input_tokens` proves it is working.

Model table (context and USD per million tokens, from the Anthropic pricing reference,
June 2026 — re-check when touching this file):

| Model | Context | Input | Output | Sends `temperature` |
|---|---|---|---|---|
| `claude-haiku-4-5` | 200K | $1.00 | $5.00 | yes |
| `claude-sonnet-5` | 1M | $2.00 | $10.00 | no |
| `claude-opus-5` | 1M | $5.00 | $25.00 | no |

`claude-haiku-4-5` stays the documented hosted option (CLAUDE.md, ROADMAP, ADR-015).
Structured output uses `output_config: { format: ... }` (not the removed `output_format`),
and tool definitions use top-level `strict: true` with `additionalProperties: false`, which
our schemas already set. No assistant prefill: it is rejected on current models.

## 6. Fake provider (`src/providers/llm/fake.ts`)

Takes a scripted list of `LlmResponse`s (or a function of the request), records every
request it received, and reports configurable usage. This is what every loop, budget, retry
and cache test runs against.

## 7. Budgets, cache, tracing (`src/harness/`)

- `budget.ts` — a `Budget` built from `config.budgets`, with `wouldExceed()` checked before
  a call and `consume()` after. Hitting a budget stops the loop and returns the partial
  result with a `stopped: "budget:<name>"` reason; it is not an error (CLAUDE.md: "keeps
  partial, valid results"). Wall clock uses an injected clock so tests are instant.
- `cache.ts` — key is `sha256(provider, model, system, messages, tools, outputSchema,
  temperature, maxOutputTokens)`; value is a stored `LlmResponse` plus the usage it
  originally cost. A cache hit contributes 0 to the budget and is traced as `cached: true`.
  Needs a cache directory (section 9).
- `tracing.ts` — appends one JSON object per line to `<runDir>/trace.jsonl`:
  stage, step, prompt hash, cached, usage, cost, duration, tool name and arguments, and the
  validation errors of a failed attempt. Secrets are never traced; the provider name and
  model are.
- `cost.ts` — folds the trace into `<runDir>/cost.json`: per stage and total token counts
  and USD, with `"unknown"` where the price table has no entry.

## 8. The loop (`src/harness/loop.ts`, `tools.ts`)

`tools.ts` defines the registry only — `ToolDefinition` (name, description, JSON Schema)
plus a `ToolHandler` and a `dispatch()` that validates arguments with Ajv, enforces a result
size cap, and turns a thrown handler into a tool result marked as an error rather than a
crashed run. The four real diff tools are step 4's scope.

`runAgent({ provider, system, messages, tools, outputSchema, budget, trace, cache })`:

1. Call the provider. On `tool_use`, run every requested tool, append all results in one
   user message, and loop.
2. On `end_turn`, parse the final JSON and validate it against `outputSchema` with Ajv.
3. On failure, append the formatted Ajv errors as a user message and retry, at most
   `llm.maxRetries` (default 2) times, then fail the stage with the last errors.
4. Stop early and return the partial result when a budget is hit or the step cap is reached.

Injection boundary: diff content only ever enters as `user` content. The system prompt is
built from repository files. The loop never promotes tool output or diff text into `system`.

## 9. Config change (needs approval)

The cache needs a home, and there is nowhere to put it today. Proposed addition to
`config/config.schema.json` and `config/default.json`, plus `pnpm gen:types`:

```json
"cache": { "enabled": true, "dir": ".cache/spr" }
```

with `SPR_CACHE_DIR` and `SPR_CACHE_ENABLED` added to the `ENV_OVERRIDES` table in
`src/config.ts` and to `.env.example`. Say the word if you would rather the cache live
inside the run folder (simpler, but then nothing is reused between runs, which defeats the
point) or be environment-only with no config entry.

## 10. Tests

No network anywhere; `fetch` and the SDK client are injected.

- Provider request shaping: Ollama sends `format`, `num_ctx` and `stream: false`; the
  Anthropic adapter omits `temperature` for `claude-opus-5` and sends it for
  `claude-haiku-4-5`, and puts `cache_control` on the last system block.
- Usage and cost: a known usage maps to the expected USD for each table entry; cache reads
  and writes are priced at their own rates; an unknown model gives `null`, not 0; Ollama
  gives 0.
- Loop: a tool round trip; several tools in one turn answered in a single user message;
  invalid output repaired on the second attempt; exhausted retries fail with the Ajv errors
  in the message; a tool handler that throws becomes an error tool result.
- Budgets: each of the five budgets stops the loop, keeps the partial result, and names
  itself in the stop reason.
- Cache: a second identical request never reaches the provider; a changed temperature,
  model, tool list or schema misses; a corrupt cache file is ignored rather than fatal.
- Trace and cost: one line per call with the documented fields, no secrets, and
  `cost.json` totals equal to the sum of the trace lines.

A manual smoke test (not in `pnpm test`, since it needs a model) runs the loop against the
local Ollama with a toy schema and tool. `ollama serve` is up on this machine with
`mistral-small3.2`, `qwen3:30b` and `qwen3:4b` pulled.

## 10a. What the model trial changed (added after the plan was drafted)

Running the real rubric against the golden samples (ADR-018) turned up two things that the
harness has to get right, because they decide whether a finding survives step 5 at all.

- **The Reviewer must be shown a diff with explicit new-side line numbers.** Given a raw
  patch, every model guessed line numbers badly: `qwen3:30b` labelled all three of its
  findings `15-15` when the real lines were 7, 13 and 22. Given the same diff rendered from
  `ingest.json` with the line number on each line, every range it produced passed
  `HunkIndex.hasRange`. The numbers are already in `ingest.json`, so this costs nothing.
- **Evidence has to be demanded, in the schema and in the prompt.** With `evidence` optional,
  `qwen3:30b` returned `[]` every time and `mistral-small3.2` invented paraphrases such as
  `this.broker.emit('order.placed', { ... })` and whole sentences of prose. Every one of those
  findings would be dropped by `containsSnippet`, including the primary bug in sample 01.
  With evidence required and the prompt demanding an exact copied line, both models produced
  snippets that matched the diff character for character.
- One failure mode survives and needs a decision: asked to copy a line exactly, `qwen3:30b`
  sometimes copies the rendered prefix too (`"  14 +  @EventPattern('order.placed')"`), which
  fails matching even though the line is real. Either the renderer uses a prefix that is
  harder to copy by accident, or `containsSnippet` strips a leading line-number and marker
  prefix before matching. Stripping cannot let a fabricated snippet through, so it is the
  safer of the two, but it changes shipped step 2 code and is listed below.

## 11. Open questions

0. **Should `evidence` become required, with `minItems: 1`?** CLAUDE.md principle 5 says
   every finding carries verbatim evidence, but the schema makes `evidence` optional with no
   minimum, and the trial shows models take that option. This is the single highest-value
   change to the review contract, and it is what made the second trial work. Needs approval.
1. ~~**`review.schema.json` caps `findings` at 10, but `config.review.maxRawFindings` is 15.**~~
   Step 4 writes `review.raw.json` against the review schema, so 15 raw findings cannot
   validate. This does not block step 3, but it blocks step 4, and it is a contract change
   either way: raise `maxItems` to 15 and let the verifier cap at 10, add a separate raw
   schema, or lower `maxRawFindings` to 10. My preference is raising `maxItems` to 15 and
   keeping the cap of 10 in the verifier, since `dropped` already records what was cut.
2. ~~The `cache` config section in section 9.~~ Approved; implemented in ADR-017.
3. Should `trace.jsonl` and `cost.json` get JSON Schemas in `schemas/`? They are
   diagnostics, not cross-stage contracts, so I propose typed interfaces and tests only.
4. Is prompt caching on by default for Anthropic acceptable? It is a cost win and changes
   nothing about output, but it does put a `cache_control` marker in the request.

## 12. Finish

1. `pnpm verify`, `pnpm format:check` and `pnpm build` pass.
2. Smoke test against local Ollama, output pasted into the report.
3. Commit as "Milestone 1 step 3: harness", push, and ask you to check CI.
4. Set step 3 to done and step 4 to next in docs/ROADMAP.md; add an ADR if the cache
   location or the raw-findings cap is decided here.
5. Report: files added, anything changed from this plan and why, open questions.
   Do not start step 4.
