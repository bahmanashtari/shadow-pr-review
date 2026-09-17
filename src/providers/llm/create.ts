/**
 * Chooses the provider named in the configuration. The default is local Ollama, which
 * needs no key and costs nothing (ADR-015).
 */
import type { SprConfig } from "../../contracts/generated/config.js";
import type { Secrets } from "../../config.js";
import { StageError } from "../../lib/errors.js";
import { AnthropicProvider } from "./anthropic.js";
import { fakeText, FakeLlmProvider } from "./fake.js";
import { OllamaProvider } from "./ollama.js";
import type { LlmProvider } from "./types.js";

/** What the fake provider answers: valid for the Reviewer, and empty on purpose. */
const EMPTY_ANSWER = {
  summary: "No model was used: the fake provider is selected, so only automated checks ran.",
  findings: [],
};

/**
 * Placeholder narration. The lengths and the wording are not arbitrary: they satisfy the
 * narration rules `checkScript` enforces, so a fake run reaches `script.json` like a real one.
 */
const STUB_NARRATION = {
  intro:
    "This is an automated run with no model, so there is no real narration here. The " +
    "findings below were produced by the deterministic checks alone.",
  step:
    "This finding has no narration because the fake provider is selected. Choose a real " +
    "model to hear it explained.",
  wrapUp:
    "That is the end of this placeholder walkthrough. Select a real model to hear the " +
    "findings explained properly in plain words.",
};

/**
 * The finding ids the Narrator's schema pins its answer to. A clean change narrates nothing,
 * and that schema carries no `items` at all, so an absent one means an empty answer.
 */
function narratedIds(schema: Record<string, unknown>): string[] {
  const properties = schema.properties as Record<string, unknown>;
  const steps = properties.steps as Record<string, unknown> | undefined;
  const item = (steps?.items as Record<string, unknown> | undefined)?.properties as
    Record<string, unknown> | undefined;
  const id = item?.finding_id as { enum?: unknown } | undefined;
  return Array.isArray(id?.enum) ? (id.enum as string[]) : [];
}

/**
 * Answers whichever stage is asking. The fake has no idea what it is reviewing, so every
 * answer is empty or placeholder, but it is always valid for the schema it was handed.
 */
function fakeAnswer(schema: Record<string, unknown> | undefined): string {
  if (schema?.title !== "NarratorAnswer") return JSON.stringify(EMPTY_ANSWER);
  return JSON.stringify({
    intro: STUB_NARRATION.intro,
    steps: narratedIds(schema).map((finding_id) => ({ finding_id, text: STUB_NARRATION.step })),
    wrap_up: STUB_NARRATION.wrapUp,
  });
}

/** Default Ollama endpoint when the config leaves `llm.baseUrl` out. */
const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** Builds the provider for a run. */
export function createProvider(config: SprConfig, secrets: Secrets = {}): LlmProvider {
  const { provider, model, baseUrl, effort, think } = config.llm;

  switch (provider) {
    case "ollama":
      return new OllamaProvider({
        model,
        baseUrl: baseUrl ?? DEFAULT_OLLAMA_URL,
        ...(think === undefined ? {} : { think }),
      });

    case "anthropic":
      return new AnthropicProvider({
        model,
        ...(secrets.anthropicApiKey === undefined ? {} : { apiKey: secrets.anthropicApiKey }),
        ...(effort === undefined ? {} : { effort }),
      });

    case "fake":
      // `SPR_LLM_PROVIDER=fake` runs the pipeline with no model at all, which is how the
      // CLI is tested and how someone can exercise a run offline. It answers every call
      // with an empty result, so the deterministic analyzers are all that contributes.
      return new FakeLlmProvider([(request) => fakeText(fakeAnswer(request.outputSchema))], {
        model,
        repeatLastTurn: true,
      });

    default: {
      const unknown: never = provider;
      throw new StageError("config", `Unknown LLM provider: ${String(unknown)}`);
    }
  }
}
