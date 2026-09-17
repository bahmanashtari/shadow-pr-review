/**
 * The TTS stage: `script.json` becomes spoken clips and, more importantly, **measured
 * durations**.
 *
 * This is the hinge of CLAUDE.md principle 1. Everything downstream - the Director, the
 * Recorder, the Composer - takes its timing from `audio/manifest.json`, and every number in
 * it comes from a file on disk. `estimated_seconds` in `script.json` is never consulted here:
 * it is the word-count guess the schema itself calls informational, and this stage exists to
 * replace it with a measurement.
 *
 * Failure is resumable by construction. Clips are written as they are produced and the cache
 * is keyed on content, so a stage that dies on step 7 of 9 leaves six clips behind and a
 * re-run replays them for free and starts work at the one that failed. Unlike the Narrator,
 * there is no handover file to write (ADR-024): that failure was a judgement the model could
 * not make, this one is a server that was not there.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkAudioManifest, countWords } from "../contracts/checks.js";
import type { AudioManifest } from "../contracts/generated/audio-manifest.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { NarrationScript } from "../contracts/generated/script.js";
import { assertContract } from "../contracts/validate.js";
import { ttsCacheKey, type TtsCache } from "../harness/cache.js";
import { ContractError, StageError } from "../lib/errors.js";
import type { TtsProvider } from "../providers/tts/types.js";
import { readWavInfo } from "./duration.js";
import { normalizeForSpeech } from "./normalize.js";

/** Folder the clips go in, relative to the run folder. */
export const AUDIO_DIR = "audio";

/** The manifest, relative to the run folder. */
export const MANIFEST_FILE = "audio/manifest.json";

/** Spoken words per second, the rate `script.schema.json` estimates with. */
const WORDS_PER_SECOND = 2.5;

/**
 * How far a clip may sit from its word-count estimate before the stage refuses it.
 *
 * This is not defensive padding. A TTS server that answers with an error page, an empty body
 * or a truncated clip produces bytes that parse, and the result is a silently broken video
 * nobody notices until they watch it. This stage prints the last numbers a person sees before
 * they become a rendered video, so the bounds are wide enough to never argue with a voice's
 * natural pace and tight enough to catch a clip that is not the narration at all.
 */
const SANITY_BOUNDS = { min: 1 / 5, max: 5 } as const;

/** Input for {@link runTts}. */
export interface RunTtsOptions {
  script: NarrationScript;
  provider: TtsProvider;
  config: SprConfig;
  cache?: TtsCache;
  /** Run folder; the clips are written under `<runDir>/audio/` as they are produced. */
  runDir: string;
}

/** What the stage produced. */
export interface TtsOutcome {
  manifest: AudioManifest;
  /** Clips served from the cache rather than synthesized. */
  cached: number;
  /** Total spoken time, the sum of every clip. Gaps between steps are the Director's. */
  totalMs: number;
}

/** One clip, measured. */
type Clip = AudioManifest["clips"][number];

/**
 * Refuses a clip whose length is nowhere near its text.
 *
 * @throws StageError naming the step, both numbers, and the most likely cause.
 */
function assertPlausible(stepId: string, text: string, durationMs: number, speed: number): void {
  const expectedMs = (countWords(text) / WORDS_PER_SECOND / speed) * 1000;
  if (expectedMs === 0) return;
  const ratio = durationMs / expectedMs;
  if (ratio >= SANITY_BOUNDS.min && ratio <= SANITY_BOUNDS.max) return;

  throw new StageError(
    "tts",
    `Step ${stepId} synthesized to ${durationMs} ms, but its ${countWords(text)} words ` +
      `should take about ${Math.round(expectedMs)} ms. The engine probably returned an ` +
      `error page, an empty body or a truncated clip rather than the narration.`,
  );
}

/**
 * Speaks a script.
 *
 * Steps are done in order, one at a time: CPU synthesis of a handful of short clips is
 * seconds, and a stage that writes its files in order is a stage whose partial output makes
 * sense to a person looking at the folder.
 */
export async function runTts(options: RunTtsOptions): Promise<TtsOutcome> {
  const { script, provider, config, cache, runDir } = options;
  const { voice, speed } = config.tts;

  mkdirSync(path.join(runDir, AUDIO_DIR), { recursive: true });

  const clips: Clip[] = [];
  const rates = new Set<number>();
  let cached = 0;

  for (const step of script.steps) {
    const text = normalizeForSpeech(step.text);
    const cacheKey = ttsCacheKey(provider.name, voice, speed, text);

    const hit = cache?.get(cacheKey);
    const wav = hit ?? (await provider.synthesize({ text, voice, speed }));
    if (hit === undefined) cache?.set(cacheKey, wav);
    else cached += 1;

    const relative = `${AUDIO_DIR}/${step.id}.wav`;
    writeFileSync(path.join(runDir, relative), wav);

    const info = readWavInfo(wav);
    assertPlausible(step.id, text, info.durationMs, speed);
    rates.add(info.sampleRate);

    clips.push({
      step_id: step.id,
      path: relative,
      duration_ms: info.durationMs,
      cache_key: cacheKey,
      cached: hit !== undefined,
    });
  }

  // The Composer concatenates these clips, and `-c copy` only works on one format. Catching
  // a mixed set here is far cheaper than catching it in ffmpeg four steps later.
  if (rates.size > 1) {
    throw new StageError(
      "tts",
      `Clips came back at different sample rates (${[...rates].sort((a, b) => a - b).join(", ")}). ` +
        `Every clip in a run must share one format.`,
    );
  }

  const manifest: AudioManifest = {
    schema_version: "1.0",
    provider: provider.name,
    voice,
    speed,
    // Measured, like the durations: what the engine actually returned, not what it was asked for.
    sample_rate: [...rates][0] ?? 0,
    clips,
  };

  assertContract("audio-manifest", manifest);
  const problems = checkAudioManifest(manifest, script);
  if (problems.length > 0) throw new ContractError(MANIFEST_FILE, problems);

  return {
    manifest,
    cached,
    totalMs: clips.reduce((sum, clip) => sum + clip.duration_ms, 0),
  };
}

/** Writes `audio/manifest.json` into a run folder. The clips are already there. */
export function writeManifest(runDir: string, manifest: AudioManifest): void {
  const file = path.join(runDir, MANIFEST_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** `2:07` or `0:48`: the shape a person reads a video length in. */
export function formatDuration(totalMs: number): string {
  const seconds = Math.round(totalMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One line such as `audio: 5 clips, 1:52 of speech (3 cached)`. */
export function summarizeTts(outcome: TtsOutcome): string {
  const clips = outcome.manifest.clips.length;
  const line = `audio: ${clips} ${clips === 1 ? "clip" : "clips"}, ${formatDuration(outcome.totalMs)} of speech`;
  return outcome.cached === 0 ? line : `${line} (${outcome.cached} cached)`;
}
