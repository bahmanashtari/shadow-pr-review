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
import { ffmpeg, hasFilter, streamDurationMs } from "./ffmpeg.js";
import { buildSrt } from "./srt.js";
import { VIDEO_FILE } from "../recorder/record.js";

/** Files this stage writes, relative to the run folder. */
export const FINAL_FILE = "final.mp4";
export const SUBTITLES_FILE = "subtitles.srt";

/** ARCHITECTURE's tolerance: beyond this the sound and the picture have come apart. */
const MAX_DRIFT_MS = 250;

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
  assertInSync(videoDurationMs, audioDurationMs);

  return {
    finalPath: FINAL_FILE,
    ...(subtitles === "sidecar" ? { subtitlesPath: SUBTITLES_FILE } : {}),
    videoDurationMs,
    audioDurationMs,
  };
}

/**
 * Refuses a file whose sound and picture have come apart.
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

/** One line such as `final.mp4: 0:57, sound and picture 12 ms apart`. */
export function summarizeCompose(outcome: ComposeOutcome): string {
  const seconds = Math.round(outcome.videoDurationMs / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const drift = Math.abs(outcome.videoDurationMs - outcome.audioDurationMs);
  const subs = outcome.subtitlesPath === undefined ? "" : `, ${outcome.subtitlesPath}`;
  return `${outcome.finalPath}: ${clock}, sound and picture ${drift} ms apart${subs}`;
}
