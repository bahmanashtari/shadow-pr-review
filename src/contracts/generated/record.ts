/* eslint-disable */
/**
 * GENERATED FILE. Do not edit by hand.
 * Source: schemas/record.schema.json. Regenerate with `pnpm gen:types`.
 */

/**
 * Contract for record.json. Produced by the Recorder alongside video.webm. Exists because the Composer needs a number that cannot live inside a .webm: t0, the length of the page-load head that recording captured before the timeline's clock started.
 */
export interface RecordResult {
  schema_version: "1.0";
  /**
   * Relative to the run folder, e.g. video.webm.
   */
  video_path: string;
  /**
   * Milliseconds of recording before the timeline started: the gap between the browser context being created and window.spr.ready. The Composer trims this from the front of the video, otherwise every visual lands late against the narration.
   */
  t0_ms: number;
  /**
   * The frame size actually recorded, which is not necessarily the size the timeline asked for.
   */
  video: {
    width: number;
    height: number;
  };
  /**
   * Wall clock the Recorder observed between t0 and closing the context. A cross-check the Composer can hold against the timeline's total_duration_ms; it is not the encoded video's duration, which only ffprobe can tell.
   */
  recorded_duration_ms: number;
}
