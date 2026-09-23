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
 * Placeholder narration. The length and the wording are not arbitrary: they satisfy the
 * narration rules `checkScript` enforces, so a fake run reaches `script.json` like a real one.
 * It names no severity, because the rule is that a step may speak only its own finding's
 * (ADR-042) and the fake has no idea which finding it is being asked about.
 */
const STUB_NARRATION =
  "This finding has no narration because the fake provider is selected. Choose a real model " +
  "to hear it explained, with what the problem is, what it leads to, and how to put it right.";

/** The finding ids the Narrator's schema pins its answer to, one step per finding. */
function narratedIds(schema: Record<string, unknown>): string[] {
  const properties = schema.properties as Record<string, unknown>;
  const steps = properties.steps as Record<string, unknown> | undefined;
  const item = (steps?.items as Record<string, unknown> | undefined)?.properties as
    Record<string, unknown> | undefined;
  const id = item?.finding_id as { enum?: unknown } | undefined;
  return Array.isArray(id?.enum) ? (id.enum as string[]) : [];
}

/**
 * What the fake answers the Verifier: keep, always.
 *
 * The one safe verdict for a judge that cannot read. A fake drop would remove a real finding
 * the analyzers produced, and a fake downgrade would rewrite its severity - so an offline run
 * would quietly disagree with a real one about what the change contains. Keeping everything
 * makes `SPR_LLM_PROVIDER=fake` mean "the deterministic layers, and nothing else".
 */
const KEEP_VERDICT = {
  verdict: "keep",
  note: "No model was used: the fake provider is selected, so nothing was judged.",
};

/**
 * Answers whichever stage is asking. The fake has no idea what it is reviewing, so every
 * answer is empty or placeholder, but it is always valid for the schema it was handed.
 */
function fakeAnswer(schema: Record<string, unknown> | undefined): string {
  if (schema?.title === "Verdict") return JSON.stringify(KEEP_VERDICT);
  if (schema?.title !== "NarratorAnswer") return JSON.stringify(EMPTY_ANSWER);
  return JSON.stringify({
    steps: narratedIds(schema).map((finding_id) => ({ finding_id, text: STUB_NARRATION })),
  });
}

/** Default Ollama endpoint when the config leaves `llm.baseUrl` out. */
const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** The stages that call a model, and may each name their own (ADR-057). */
export type ModelStage = "review" | "verify" | "narrate";

/**
 * The model a stage runs on: its own override when the configuration names one, otherwise
 * `llm.model`. One model everywhere remains the default, and a comparison is what should
 * change that (ADR-057).
 */
export function modelFor(config: SprConfig, stage?: ModelStage): string {
  const override = stage === undefined ? undefined : config.llm.models?.[stage];
  return override ?? config.llm.model;
}

/**
 * Builds the provider for a stage. Without a stage it uses `llm.model`, which is what the
 * fake provider and the tests want.
 */
export function createProvider(
  config: SprConfig,
  secrets: Secrets = {},
  stage?: ModelStage,
): LlmProvider {
  const { provider, baseUrl, effort, think } = config.llm;
  const model = modelFor(config, stage);

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
