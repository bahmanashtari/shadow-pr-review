/**
 * Chooses the provider named in the configuration. The default is local Ollama, which
 * needs no key and costs nothing (ADR-015).
 */
import type { SprConfig } from "../../contracts/generated/config.js";
import type { Secrets } from "../../config.js";
import { StageError } from "../../lib/errors.js";
import { AnthropicProvider } from "./anthropic.js";
import { FakeLlmProvider } from "./fake.js";
import { OllamaProvider } from "./ollama.js";
import type { LlmProvider } from "./types.js";

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
      // Only reachable when a test or a config file asks for it explicitly.
      return new FakeLlmProvider([], { model });

    default: {
      const unknown: never = provider;
      throw new StageError("config", `Unknown LLM provider: ${String(unknown)}`);
    }
  }
}
