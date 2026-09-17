/**
 * One audio track from many clips: the narration in timeline order, with silence for the gaps.
 *
 * Built with ffmpeg's concat demuxer rather than a `filter_complex` graph, and the reason is
 * what it leaves behind (plan m2-step5, Q2). `audio/full.wav` is a file somebody can play when
 * the timing looks wrong, and `audio/list.txt` says in plain text exactly what was joined in
 * what order. This stage's failure mode is "the sound does not line up with the picture", which
 * is far easier to diagnose against artifacts than against a filter expression.
 *
 * `-c copy` keeps the join lossless. It requires every input to share a codec, sample rate and
 * channel layout - which holds because the TTS stage refuses a run whose clips disagree
 * (ADR-027), and because the silence is generated to match the clips rather than assumed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AudioManifest } from "../contracts/generated/audio-manifest.js";
import type { Timeline } from "../contracts/generated/timeline.js";
import { StageError } from "../lib/errors.js";
import { readWavInfo } from "../tts/duration.js";
import { ffmpeg } from "./ffmpeg.js";

/** Files this module writes, relative to the run folder. */
export const FULL_AUDIO_FILE = "audio/full.wav";
export const GAP_FILE = "audio/gap.wav";
export const LIST_FILE = "audio/list.txt";

/**
 * The concat demuxer's list format. Paths are single-quoted and relative to the list file, so
 * a run folder with a space or an apostrophe in its name cannot break the join.
 */
export function buildList(clipNames: readonly string[]): string {
  return clipNames.map((name) => `file '${name.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/** The clip and gap files to join, in order: a gap between each pair of clips, never at an end. */
export function joinOrder(manifest: AudioManifest, gapMs: number): string[] {
  const clips = manifest.clips.map((clip) => path.basename(clip.path));
  if (gapMs <= 0) return clips;
  return clips.flatMap((name, i) => (i === 0 ? [name] : [path.basename(GAP_FILE), name]));
}

/**
 * Builds `audio/full.wav` and returns its path relative to the run folder.
 *
 * The silence is generated in the clips' own format, read off the first clip's header rather
 * than assumed, because `-c copy` would refuse the join otherwise and because Kokoro's format
 * is a fact about Kokoro rather than a constant of this program.
 */
export async function buildFullAudio(
  runDir: string,
  manifest: AudioManifest,
  timeline: Timeline,
): Promise<string> {
  const first = manifest.clips[0];
  if (first === undefined) throw new StageError("compose", "The manifest has no clips to join.");

  const info = readWavInfo(readFileSync(path.join(runDir, first.path)));
  const gapMs = timeline.gap_ms;

  if (gapMs > 0) {
    await ffmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=${info.sampleRate}:cl=${info.channels === 1 ? "mono" : "stereo"}`,
        "-t",
        (gapMs / 1000).toFixed(3),
        "-c:a",
        `pcm_s${info.bitsPerSample}le`,
        GAP_FILE,
      ],
      runDir,
    );
  }

  writeFileSync(path.join(runDir, LIST_FILE), buildList(joinOrder(manifest, gapMs)), "utf8");

  await ffmpeg(
    ["-y", "-f", "concat", "-safe", "0", "-i", LIST_FILE, "-c", "copy", FULL_AUDIO_FILE],
    runDir,
  );
  return FULL_AUDIO_FILE;
}
