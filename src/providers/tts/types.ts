/**
 * A provider-neutral view of a speech engine.
 *
 * The shape mirrors `providers/llm/types.ts` and is just as deliberately not one vendor's:
 * the default is a local Kokoro container (ADR-004), and Piper or any OpenAI-compatible
 * service must be able to take its place without anything above this file noticing.
 *
 * A provider returns WAV bytes and says nothing about how long they are. Duration is measured
 * from the bytes themselves (ADR-027), never reported by the thing that produced them.
 */

/** Providers the config may select. */
export type TtsProviderName = "kokoro-http" | "piper" | "fake";

/** One synthesis request. Also the input to the cache key. */
export interface TtsRequest {
  /** Already normalized (`src/tts/normalize.ts`); a provider does not touch the words. */
  text: string;
  voice: string;
  /** 1.0 is the voice's own pace; the schema allows 0.5 to 2.0. */
  speed: number;
}

/** A speech engine the TTS stage can drive. */
export interface TtsProvider {
  readonly name: TtsProviderName;
  /** WAV bytes for `text`. Throws a StageError the CLI can print when the engine is not there. */
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<Uint8Array>;
}
