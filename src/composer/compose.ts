/**
 * The Compose stage: the silent video and the measured audio become `final.mp4`.
 *
 * This is where the two halves of the pipeline meet, and where its accumulated timing error
 * becomes visible for the first time. A mismeasured clip in the TTS stage, an arithmetic slip
 * in the Director, a scheduler that drifted in the Recorder - all of them arrive here as a
 * mismatch between how long the picture runs and how long the sound does. Nothing earlier could
 * see it: step 4 had no `ffprobe` and could only report the wall clock it observed itself.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AudioManifest } from "../contracts/generated/audio-manifest.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { RecordResult } from "../contracts/generated/record.js";
import type { NarrationScript } from "../contracts/generated/script.js";
import type { Timeline } from "../contracts/generated/timeline.js";
import { StageError } from "../lib/errors.js";
import { buildFullAudio } from "./audio.js";
import { containerDurationMs, ffmpeg, hasFilter, streamDurationMs } from "./ffmpeg.js";
import { buildSrt } from "./srt.js";
import { VIDEO_FILE } from "../recorder/record.js";

/** Files this stage writes, relative to the run folder. */
export const FINAL_FILE = "final.mp4";
export const SUBTITLES_FILE = "subtitles.srt";

/** ARCHITECTURE's tolerance: beyond this the sound and the picture have come apart. */
const MAX_DRIFT_MS = 250;

/**
 * The tolerance on a duration that should match a computed one exactly (ADR-035).
 *
 * One video frame at 25 fps. The audio track is joined from clips this pipeline measured
 * itself, so it should land on the schedule to the millisecond, and on three complete runs it
 * did - by 0.2, 1.0 and 0.7 ms. The failure this guards against missed by 429. There is a lot
 * of room between those two numbers and no reason to spend it.
 */
const MAX_SHORTFALL_MS = 40;

/** Input for {@link runCompose}. */
export interface RunComposeOptions {
  timeline: Timeline;
  manifest: AudioManifest;
  script: NarrationScript;
  record: RecordResult;
  config: SprConfig;
  runDir: string;
}

/** What the stage produced. */
export interface ComposeOutcome {
  /** Relative to the run folder. */
  finalPath: string;
  /** Relative to the run folder, when subtitles were written as a sidecar. */
  subtitlesPath?: string;
  videoDurationMs: number;
  audioDurationMs: number;
}

/**
 * The encoder arguments. H.264 and AAC because they play everywhere, and `+faststart` so the
 * moov atom is at the front and the file streams rather than having to download first - which
 * matters when the destination is a pull request comment.
 */
const ENCODE = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "23",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-shortest",
  "-movflags",
  "+faststart",
];

/** Composes the final video. */
export async function runCompose(options: RunComposeOptions): Promise<ComposeOutcome> {
  const { timeline, manifest, script, record, config, runDir } = options;

  const video = path.join(runDir, VIDEO_FILE);
  if (!existsSync(video)) {
    throw new StageError(
      "compose",
      `No ${VIDEO_FILE} in ${runDir}. Run \`spr stage record --run ${runDir}\` first.`,
    );
  }

  // Before any encoding: two derivations of the narration's length that must already agree,
  // and there is no point spending a minute of ffmpeg on a run whose inputs do not.
  assertScheduleAgrees(manifest, timeline);

  const audioPath = await buildFullAudio(runDir, manifest, timeline);
  const subtitles = config.video.subtitles;

  if (subtitles === "burn" && !(await hasFilter("subtitles"))) {
    throw new StageError(
      "compose",
      `This ffmpeg cannot burn subtitles in: it was built without libass, so it has no ` +
        `"subtitles" filter. Install a build that has one (\`brew install ffmpeg-full\`; ` +
        `Debian and Ubuntu packages already do), or set video.subtitles to "sidecar", which ` +
        `ships the same cues as a separate file and needs no filter.`,
    );
  }

  // Written whenever subtitles are wanted at all: burning reads it as an input file.
  const srtPath = path.join(runDir, SUBTITLES_FILE);
  if (subtitles !== "off") writeFileSync(srtPath, buildSrt(timeline, script), "utf8");

  // How long the picture may be, stated rather than inferred (ADR-053). Playwright's webm
  // always outruns the schedule - by 1.6 to 2.1 s on this project's runs - and `-shortest`
  // used to absorb that, until the same run inside the tool's own image, on ffmpeg 5.1 rather
  // than 9.0, left 1.2 s of picture past the end of the sound and failed the sync check.
  // Correctness must not turn on which ffmpeg is installed, so the narration's own length is
  // passed in. A recording shorter than this still ends where it ends, and the two checks
  // below still catch it.
  const narrationMs = expectedAudioMs(manifest, timeline.gap_ms);

  await ffmpeg(
    [
      "-y",
      // Before -i, so the trim is a seek rather than a decode-and-discard: this is what
      // removes the page-load frames the Recorder captured before the timeline started.
      "-ss",
      (record.t0_ms / 1000).toFixed(3),
      "-i",
      VIDEO_FILE,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      // A relative path, because the filter's own syntax gives ':' and '\' meaning. No
      // `force_style`: styling is Milestone 5's, and every option added here is another
      // string to escape for a parser with its own quoting rules. The single quotes the
      // cheat sheet shows are shell syntax, and `src/lib/exec.ts` runs without a shell.
      ...(subtitles === "burn" ? ["-vf", `subtitles=${SUBTITLES_FILE}`] : []),
      "-t",
      (narrationMs / 1000).toFixed(3),
      ...ENCODE,
      FINAL_FILE,
    ],
    runDir,
  );

  // Burned-in subtitles are part of the picture; leaving the sidecar as well would offer a
  // viewer two copies of the same words.
  if (subtitles === "burn" && existsSync(srtPath)) unlinkSync(srtPath);

  const videoDurationMs = (await streamDurationMs(FINAL_FILE, "video", runDir)) ?? 0;
  const audioDurationMs = (await streamDurationMs(FINAL_FILE, "audio", runDir)) ?? 0;

  // The recording is probed rather than trusted: `record.json` carries the wall clock the
  // Recorder observed, which is not the same thing as what Playwright wrote to disk - the two
  // were 678 ms apart on the run that failed (ADR-034). Asked for only now, and only to tell
  // the two causes apart, so a healthy run pays one ffprobe for it.
  const webmMs = await containerDurationMs(VIDEO_FILE, runDir);
  assertAudioComplete({
    expectedMs: expectedAudioMs(manifest, timeline.gap_ms),
    finalAudioMs: audioDurationMs,
    trimmedVideoMs: webmMs === undefined ? undefined : webmMs - record.t0_ms,
    runDir,
  });
  assertInSync(videoDurationMs, audioDurationMs);

  return {
    finalPath: FINAL_FILE,
    ...(subtitles === "sidecar" ? { subtitlesPath: SUBTITLES_FILE } : {}),
    videoDurationMs,
    audioDurationMs,
  };
}

/**
 * How long `audio/full.wav` will be: every clip end to end, with one gap between each pair and
 * none at either end - the same rule `joinOrder` joins by, derived here rather than measured,
 * so the two can be compared.
 */
export function expectedAudioMs(manifest: AudioManifest, gapMs: number): number {
  const clips = manifest.clips.reduce((total, clip) => total + clip.duration_ms, 0);
  const gaps = gapMs > 0 ? gapMs * Math.max(0, manifest.clips.length - 1) : 0;
  return clips + gaps;
}

/**
 * Refuses a run whose schedule and whose clips disagree about how long the narration is.
 *
 * Two independent derivations of the same number: the Director laid out `step_windows` from the
 * measured clips, and {@link expectedAudioMs} adds those clips up again. They can only differ
 * if one of the two is wrong, and finding out here is better than encoding a file around it.
 * Nothing external is consulted, so this holds even where no recording exists yet.
 */
export function assertScheduleAgrees(manifest: AudioManifest, timeline: Timeline): void {
  const last = timeline.step_windows.at(-1);
  if (last === undefined) throw new StageError("compose", "The timeline has no step windows.");

  const expected = expectedAudioMs(manifest, timeline.gap_ms);
  const difference = last.end_ms - expected;
  if (Math.abs(difference) <= MAX_SHORTFALL_MS) return;

  throw new StageError(
    "compose",
    `The schedule and the clips disagree by ${String(Math.abs(difference))} ms: ` +
      `timeline.json ends its last step at ${String(last.end_ms)} ms, but audio/manifest.json's ` +
      `clips and ${String(timeline.gap_ms)} ms gaps add up to ${String(expected)} ms. ` +
      `One of the two was built from stale inputs - re-run \`spr stage direct\` to rebuild the ` +
      `schedule from the clips that are actually on disk.`,
  );
}

/**
 * Refuses a `final.mp4` that is missing narration, and says which stage to go back to.
 *
 * This is the check that `assertInSync` cannot be. `-shortest` ends the output when the shorter
 * *input* ends, so when the recording comes up short the encoder cuts the sound to fit it - and
 * the two streams that come out agree with each other perfectly, because the encoder made them
 * agree. Measuring against `expected`, which no part of the encode can influence, is the only
 * way to see it (ADR-034, ADR-035).
 *
 * `trimmedVideoMs` separates the two causes. A video shorter than the narration means the
 * recording is at fault and re-recording is the remedy; a long enough video means the audio
 * track itself came out short, which points at the join instead.
 */
export function assertAudioComplete(options: {
  expectedMs: number;
  finalAudioMs: number;
  trimmedVideoMs: number | undefined;
  runDir: string;
}): void {
  const { expectedMs, finalAudioMs, trimmedVideoMs, runDir } = options;
  const shortfall = expectedMs - finalAudioMs;
  if (Math.abs(shortfall) <= MAX_SHORTFALL_MS) return;

  const measured = `${FINAL_FILE} carries ${String(finalAudioMs)} ms of sound where the clips and gaps come to ${String(expectedMs)} ms`;

  if (shortfall < 0) {
    throw new StageError(
      "compose",
      `${String(-shortfall)} ms more sound than the schedule allows: ${measured}. ` +
        `The join is the place to look: audio/list.txt says what went in and in what order, ` +
        `and audio/full.wav is the result, which can be played.`,
    );
  }

  const short =
    trimmedVideoMs !== undefined && trimmedVideoMs < expectedMs - MAX_SHORTFALL_MS
      ? `The recording is the cause: after trimming t0 the picture runs ${String(trimmedVideoMs)} ms, ` +
        `less than the narration, and \`-shortest\` cut the sound to fit it. Recording is real ` +
        `time and does not always write everything it captured, so re-recording is a real remedy: ` +
        `\`spr stage record --run ${runDir}\`, then \`spr stage compose --run ${runDir}\`.`
      : `The picture was long enough, so the audio track itself came out short. audio/list.txt ` +
        `says what was joined and audio/full.wav is the result - play it and compare against ` +
        `audio/manifest.json. \`spr stage tts --run ${runDir}\` rebuilds the clips.`;

  throw new StageError(
    "compose",
    `${String(shortfall)} ms of narration is missing from the video: ${measured}. ` +
      `${short} The run folder is kept, so nothing has to be re-reviewed or re-spoken.`,
  );
}

/**
 * Reports how far the final file's own two streams sit apart.
 *
 * **This cannot certify that the video is complete**, and it was read that way once (ADR-034).
 * `-shortest` forces the two streams it compares into agreement, so what is left to measure is
 * frame granularity - the picture ends on the last whole frame at or before the sound does, 69
 * to 77 ms short at 25 fps. {@link assertAudioComplete} is the check with a reference outside
 * the encode. This one stays as a loose net for a gross failure that survives `-shortest`, such
 * as a burn-in filter that changed the frame rate.
 *
 * The message names which side is longer, because the two point at different stages: video
 * longer than audio means the recording overran its timeline, audio longer means the clips add
 * up to more than the schedule allowed for them.
 */
export function assertInSync(videoMs: number, audioMs: number): void {
  const drift = videoMs - audioMs;
  if (Math.abs(drift) < MAX_DRIFT_MS) return;

  const longer = drift > 0 ? "video" : "audio";
  const hint =
    drift > 0
      ? "the recording ran past its timeline"
      : "the clips add up to more than the schedule allowed";
  throw new StageError(
    "compose",
    `Sound and picture are ${Math.abs(drift)} ms apart (video ${videoMs} ms, audio ${audioMs} ms). ` +
      `The ${longer} is longer, which usually means ${hint}.`,
  );
}

/**
 * One line such as `final.mp4: 0:57, narration complete, 77 ms of trailing frame${subs}`.
 *
 * It leads with the check that means something. The old line led with the drift figure and read
 * as a sync guarantee, which is exactly how a truncated video came to be reported as the
 * project's best result (ADR-034); the frame figure is still worth printing, but as the
 * quantization it is rather than as evidence.
 */
export function summarizeCompose(outcome: ComposeOutcome): string {
  const seconds = Math.round(outcome.videoDurationMs / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const frame = outcome.audioDurationMs - outcome.videoDurationMs;
  const subs = outcome.subtitlesPath === undefined ? "" : `, ${outcome.subtitlesPath}`;
  return `${outcome.finalPath}: ${clock}, narration complete, picture ${frame} ms short of it${subs}`;
}
