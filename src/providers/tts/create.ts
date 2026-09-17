/**
 * Chooses the speech engine named in the configuration. The default is a local Kokoro
 * container, which needs no key and costs nothing (ADR-004).
 */
import type { SprConfig } from "../../contracts/generated/config.js";
import { StageError } from "../../lib/errors.js";
import { FakeTtsProvider } from "./fake.js";
import { KokoroHttpProvider } from "./kokoro-http.js";
import type { TtsProvider } from "./types.js";

/** Builds the TTS provider for a run. */
export function createTtsProvider(config: SprConfig): TtsProvider {
  const { provider, baseUrl } = config.tts;

  switch (provider) {
    case "kokoro-http":
      return new KokoroHttpProvider({ baseUrl });

    case "fake":
      // `SPR_TTS_PROVIDER=fake` walks the whole pipeline with no container at all, which is
      // how the CLI is tested and how the Director and Recorder can be built before anyone
      // installs Docker. It returns real WAV bytes, so the timings are plausible.
      return new FakeTtsProvider();

    case "piper":
      // Named in the config schema as the planned lighter fallback (see the cheat sheet),
      // but nothing has needed it yet.
      throw new StageError(
        "config",
        `The "piper" TTS provider is not implemented yet. Use "kokoro-http", or "fake" to ` +
          `run without audio.`,
      );

    default: {
      const unknown: never = provider;
      throw new StageError("config", `Unknown TTS provider: ${String(unknown)}`);
    }
  }
}
