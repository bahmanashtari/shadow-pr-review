/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/script.schema.json. Regenerate with `pnpm gen:types`.
 */

/**
 * Contract for script.json. Produced by the Narrator agent from verified findings. One step per kept finding and nothing else: a video exists to explain issues that were found, so there is no intro, no wrap-up and no title (ADR-042), and a review with no findings produces no script and no video at all. Code-level validators must additionally enforce: every step references a finding id present in review.json, in the review's order, focus matches that finding's location, and the narration speaks no severity but its own finding's.
 */
export interface NarrationScript {
  schema_version: "1.0";
  language?: string;
  /**
   * One per kept finding, in the review's order. The ceiling is review.maxFindings, because that is the most findings that can reach here.
   *
   * @minItems 1
   * @maxItems 10
   */
  steps: Step[];
}
export interface Step {
  id: string;
  finding_id: string;
  /**
   * Spoken text. Plain sentences only: no markdown, no code blocks, no file extensions read aloud. Target at most ~60 words (~25 seconds).
   */
  text: string;
  /**
   * Optional on-screen text if it should differ from the spoken text. Defaults to text.
   */
  subtitle?: string | null;
  /**
   * Where on screen this step looks. Never null: every step is about a finding, and a finding has a location.
   */
  focus: {
    file: string;
    side: "new" | "old";
    line_start: number;
    line_end: number;
  };
  /**
   * Word count / 2.5. Informational; real durations come from the TTS stage.
   */
  estimated_seconds?: number;
}
