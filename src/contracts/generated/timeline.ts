/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/timeline.schema.json. Regenerate with `pnpm gen:types`.
 */

/**
 * Contract for timeline.json. Produced deterministically by the Director from script.json + audio/manifest.json. The Recorder executes actions in order; the Composer uses step_windows to place audio and subtitles. All times are relative to the moment the Recorder marks t=0 (after the page has loaded).
 */
export interface Timeline {
  schema_version: "1.0";
  render_mode: "diff2html" | "github";
  video: {
    width: number;
    height: number;
    theme?: "light" | "dark";
  };
  /**
   * Silence inserted between steps.
   */
  gap_ms: number;
  total_duration_ms: number;
  /**
   * When each step's audio plays. start_ms of step n+1 = end_ms of step n + gap_ms.
   */
  step_windows: {
    step_id: string;
    start_ms: number;
    end_ms: number;
  }[];
  actions: {
    at_ms: number;
    step_id: string;
    type:
      | "show_title"
      | "hide_title"
      | "open_file"
      | "scroll_to"
      | "highlight"
      | "clear_highlight"
      | "show_outro";
    file?: string;
    side?: "new" | "old";
    line_start?: number;
    line_end?: number;
    text?: string;
    animation_ms?: number;
  }[];
}
