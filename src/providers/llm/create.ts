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
      return new FakeLlmProvider([() => fakeText(JSON.stringify(EMPTY_ANSWER))], {
        model,
        repeatLastTurn: true,
      });

    default: {
      const unknown: never = provider;
      throw new StageError("config", `Unknown LLM provider: ${String(unknown)}`);
    }
  }
}
