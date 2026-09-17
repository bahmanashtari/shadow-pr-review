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
import { writeFileSync } from "node:fs";
import path from "node:path";
import { checkAudioManifest, checkTimeline } from "../contracts/checks.js";
import type { AudioManifest } from "../contracts/generated/audio-manifest.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { NarrationScript } from "../contracts/generated/script.js";
import type { Timeline } from "../contracts/generated/timeline.js";
import { assertContract } from "../contracts/validate.js";
import { ContractError } from "../lib/errors.js";
import { formatDuration, MANIFEST_FILE } from "../tts/speak.js";
import { buildTimeline } from "./timeline.js";

/** File this stage writes. */
export const TIMELINE_FILE = "timeline.json";

/** Input for {@link runDirect}. */
export interface RunDirectOptions {
  script: NarrationScript;
  manifest: AudioManifest;
  config: SprConfig;
}

/** What the stage produced. */
export interface DirectOutcome {
  timeline: Timeline;
}

/** Turns a spoken script into the schedule the Recorder executes. */
export function runDirect(options: RunDirectOptions): DirectOutcome {
  const { script, manifest, config } = options;

  const mismatched = checkAudioManifest(manifest, script);
  if (mismatched.length > 0) throw new ContractError(MANIFEST_FILE, mismatched);

  const timeline = buildTimeline(script, manifest, config);

  assertContract("timeline", timeline);
  const problems = checkTimeline(timeline, manifest);
  if (problems.length > 0) throw new ContractError(TIMELINE_FILE, problems);

  return { timeline };
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
