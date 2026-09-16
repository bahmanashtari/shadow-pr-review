/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/script.schema.json. Regenerate with `pnpm gen:types`.
 */

/**
 * Contract for script.json. Produced by the Narrator agent from verified findings. Code-level validators must additionally enforce: first step is intro, last step is wrap_up, every finding step references a finding id present in review.json, and focus matches that finding's location.
 */
export interface NarrationScript {
  schema_version: "1.0";
  /**
   * Shown on the title card.
   */
  title: string;
  language?: string;
  /**
   * @minItems 2
   * @maxItems 12
   */
  steps: Step[];
}
export interface Step {
  id: string;
  kind: "intro" | "finding" | "wrap_up";
  finding_id: string | null;
  /**
   * Spoken text. Plain sentences only: no markdown, no code blocks, no file extensions read aloud. Target at most ~60 words (~25 seconds).
   */
  text: string;
  /**
   * Optional on-screen text if it should differ from the spoken text. Defaults to text.
   */
  subtitle?: string | null;
  focus: null | {
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
