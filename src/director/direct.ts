/**
 * The Direct stage: `script.json` plus `audio/manifest.json` become `timeline.json`.
 *
 * A thin shell over `buildTimeline`. All it adds is reading, checking and writing - the
 * arithmetic it wraps has no I/O in it at all, which is why the interesting tests are in
 * `test/director/timeline.test.ts` and not here.
 *
 * Both contracts are checked before anything is written. `checkAudioManifest` runs first,
 * because a script and a manifest that disagree produce a timeline whose windows are silently
 * wrong, and the useful error names the mismatch rather than the symptom.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkAudioManifest, checkTimeline } from "../contracts/checks.js";
import type { AudioManifest } from "../contracts/generated/audio-manifest.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { ReviewResult } from "../contracts/generated/review.js";
import type { NarrationScript } from "../contracts/generated/script.js";
import type { Timeline } from "../contracts/generated/timeline.js";
import { assertContract, validateContract } from "../contracts/validate.js";
import { ContractError, StageError } from "../lib/errors.js";
import { formatDuration, MANIFEST_FILE } from "../tts/speak.js";
import { summarizeFindings } from "./outro.js";
import { buildTimeline } from "./timeline.js";

/** File this stage writes. */
export const TIMELINE_FILE = "timeline.json";

/** Input for {@link runDirect}. */
export interface RunDirectOptions {
  script: NarrationScript;
  manifest: AudioManifest;
  /**
   * The verified review, read only to work out what the outro card says (plan m2-step3, Q6).
   * Severity is not carried on a script step, so the count-and-breakdown line cannot be
   * derived from the narration alone. Omitting it leaves the card blank rather than failing.
   */
  review?: ReviewResult;
  config: SprConfig;
}

/** What the stage produced. */
export interface DirectOutcome {
  timeline: Timeline;
}

/** Turns a spoken script into the schedule the Recorder executes. */
export function runDirect(options: RunDirectOptions): DirectOutcome {
  const { script, manifest, review, config } = options;

  const mismatched = checkAudioManifest(manifest, script);
  if (mismatched.length > 0) throw new ContractError(MANIFEST_FILE, mismatched);

  const timeline = buildTimeline(script, manifest, config, {
    ...(review === undefined ? {} : { outroText: summarizeFindings(review) }),
  });

  assertContract("timeline", timeline);
  const problems = checkTimeline(timeline, manifest);
  if (problems.length > 0) throw new ContractError(TIMELINE_FILE, problems);

  return { timeline };
}

/**
 * Reads and validates an existing `timeline.json`, the Recorder's input.
 * Through the file rather than through memory, like every other stage boundary.
 */
export function readTimeline(runDir: string): Timeline {
  const file = path.join(runDir, TIMELINE_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new StageError("record", `Cannot read ${file}`, { cause });
  }
  const result = validateContract("timeline", parsed);
  if (!result.ok) throw new ContractError(file, result.errors);
  return result.value;
}

/** Writes `timeline.json` into a run folder. */
export function writeTimeline(runDir: string, timeline: Timeline): void {
  writeFileSync(path.join(runDir, TIMELINE_FILE), `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
}

/** One line such as `timeline: 4 steps, 12 actions, 0:58 of video`. */
export function summarizeDirect(outcome: DirectOutcome): string {
  const { step_windows, actions, total_duration_ms } = outcome.timeline;
  return (
    `timeline: ${step_windows.length} ${step_windows.length === 1 ? "step" : "steps"}, ` +
    `${actions.length} actions, ${formatDuration(total_duration_ms)} of video`
  );
}
