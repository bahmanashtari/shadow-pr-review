/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/audio-manifest.schema.json. Regenerate with `pnpm gen:types`.
 */

/**
 * Contract for audio/manifest.json. Produced by the TTS stage. Durations are measured from the written files (ffprobe or the WAV header), never estimated.
 */
export interface AudioManifest {
  schema_version: "1.0";
  provider: string;
  voice: string;
  speed?: number;
  sample_rate: number;
  /**
   * @minItems 1
   */
  clips: {
    step_id: string;
    /**
     * Relative to the run folder, e.g. audio/S01.wav
     */
    path: string;
    duration_ms: number;
    /**
     * sha256 of provider + voice + speed + normalized text.
     */
    cache_key: string;
    cached?: boolean;
  }[];
}
