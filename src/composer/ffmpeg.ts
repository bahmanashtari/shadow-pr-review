/**
 * The two external binaries this stage needs, and what to say when they are missing.
 *
 * ADR-027 kept `ffmpeg` out of the project until here, so this is the first place it can be
 * absent. It gets the same treatment the Kokoro client and the browser launcher already have:
 * a message naming the command that fixes it, per platform, rather than a spawn error.
 *
 * Playwright's bundled ffmpeg cannot stand in for this. It has exactly two encoders, PNG and
 * libvpx VP8, because it exists to turn a screencast into a WebM - no H.264, no AAC, no libass.
 */
import { run } from "../lib/exec.js";
import { StageError } from "../lib/errors.js";

/** Encoding a minute of video takes a while; the default 30 s timeout is not enough. */
const FFMPEG_TIMEOUT_MS = 600_000;

function missing(binary: string, cause: unknown): StageError {
  const install =
    process.platform === "darwin" ? "brew install ffmpeg" : "sudo apt-get install -y ffmpeg";
  return new StageError(
    "compose",
    `Cannot run ${binary}. Install it with \`${install}\`. ` +
      `Playwright's bundled ffmpeg will not do: it only encodes VP8 and PNG.`,
    { cause },
  );
}

/** True when a binary can be executed at all, used to skip tests that need one. */
export async function hasBinary(binary: string): Promise<boolean> {
  try {
    await run(binary, ["-version"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this ffmpeg build has a given filter.
 *
 * Needed because burning subtitles in requires `libass`, and not every build has it: Debian
 * and Ubuntu packages do, and Homebrew's regular `ffmpeg` formula does not - only `ffmpeg-full`.
 * Without this check the failure is ffmpeg's filter parser complaining about option names,
 * which says nothing about the actual problem.
 */
export async function hasFilter(name: string): Promise<boolean> {
  try {
    const out = await run("ffmpeg", ["-hide_banner", "-filters"], { timeoutMs: 15_000 });
    return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(out);
  } catch {
    return false;
  }
}

/** Runs ffmpeg with `cwd` set, so every path in the arguments can stay relative. */
export async function ffmpeg(args: readonly string[], cwd: string): Promise<string> {
  try {
    return await run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
      cwd,
      timeoutMs: FFMPEG_TIMEOUT_MS,
    });
  } catch (cause) {
    if (isMissing(cause)) throw missing("ffmpeg", cause);
    throw cause;
  }
}

/** Runs ffprobe with `cwd` set. */
export async function ffprobe(args: readonly string[], cwd: string): Promise<string> {
  try {
    return await run("ffprobe", ["-hide_banner", ...args], { cwd, timeoutMs: 60_000 });
  } catch (cause) {
    if (isMissing(cause)) throw missing("ffprobe", cause);
    throw cause;
  }
}

/** Distinguishes "the binary is not there" from "the binary ran and refused". */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT";
}

/**
 * The duration of a media file's first stream of a kind, in milliseconds.
 * @returns the duration, or undefined when the file has no such stream.
 */
export async function streamDurationMs(
  file: string,
  kind: "video" | "audio",
  cwd: string,
): Promise<number | undefined> {
  const out = await ffprobe(
    [
      "-v",
      "error",
      "-select_streams",
      kind === "video" ? "v:0" : "a:0",
      "-show_entries",
      "stream=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    cwd,
  );
  const seconds = Number(out.trim().split("\n")[0]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}
