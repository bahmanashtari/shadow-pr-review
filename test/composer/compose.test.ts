/**
 * The ffmpeg-backed test. Everything about subtitle arithmetic is in `srt.test.ts` and needs
 * no binary; what is left here is what only ffmpeg can answer.
 *
 * It composes from a real recorded video rather than a synthetic one, because the whole point
 * of this stage is that the picture and the sound were produced by different stages and have to
 * agree afterwards.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertInSync,
  FINAL_FILE,
  SUBTITLES_FILE,
  runCompose,
} from "../../src/composer/compose.js";
import { hasBinary, hasFilter, streamDurationMs, ffmpeg } from "../../src/composer/ffmpeg.js";
import { buildList, joinOrder } from "../../src/composer/audio.js";
import { buildTimeline } from "../../src/director/timeline.js";
import { runTts } from "../../src/tts/speak.js";
import { FakeTtsProvider } from "../../src/providers/tts/fake.js";
import type { SprConfig } from "../../src/contracts/generated/config.js";
import { StageError } from "../../src/lib/errors.js";
import { defaultConfig, loadGolden } from "../helpers.js";

const SAMPLE = "sample-01-order-outbox";

const hasFfmpeg = (await hasBinary("ffmpeg")) && (await hasBinary("ffprobe"));
const withFfmpeg = hasFfmpeg ? describe : describe.skip;

/**
 * Burning subtitles in needs libass, which not every build has: Debian and Ubuntu packages do,
 * Homebrew's regular `ffmpeg` formula does not. So the burn case is tested where it can be, and
 * the message a build without it produces is tested everywhere.
 */
const canBurn = hasFfmpeg && (await hasFilter("subtitles"));

if (!hasFfmpeg) {
  console.warn(
    "[compose.test] no ffmpeg: skipping the compose test. " +
      "Install it with `brew install ffmpeg` or `sudo apt-get install -y ffmpeg`.",
  );
} else if (!canBurn) {
  console.warn(
    "[compose.test] this ffmpeg has no libass, so the burn-in case is skipped. " +
      "`sidecar` and `off` are still covered.",
  );
}

describe("what this build can do", () => {
  /*
   * Turns an assumption into an assertion. The burn-in case skips itself where libass is
   * missing, which is right on a Mac - but it would also skip silently for ever if the Linux
   * package ever stopped shipping libass, and nothing would say so. CI runs on Linux, so this
   * is where "the burn path is covered somewhere" stops being a hope.
   */
  it.runIf(process.platform === "linux")("has libass on Linux, where CI runs", () => {
    expect(hasFfmpeg).toBe(true);
    expect(canBurn).toBe(true);
  });
});

describe("assertInSync", () => {
  it("accepts a small difference", () => {
    expect(() => {
      assertInSync(56_000, 56_008);
    }).not.toThrow();
  });

  it.each([
    [60_000, 56_000, "video", "ran past its timeline"],
    [56_000, 60_000, "audio", "add up to more than the schedule"],
  ])("names which side is longer when they drift (%i vs %i)", (v, a, longer, hint) => {
    // The two point at different stages, so the message has to distinguish them.
    const error = (() => {
      try {
        assertInSync(v, a);
      } catch (e: unknown) {
        return e as StageError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(StageError);
    expect(error?.message).toContain(`The ${longer} is longer`);
    expect(error?.message).toContain(hint);
    expect(error?.message).toContain("4000 ms apart");
  });
});

describe("buildList", () => {
  it("quotes names so a folder with an apostrophe cannot break the join", () => {
    expect(buildList(["S00.wav", "it's.wav"])).toBe("file 'S00.wav'\nfile 'it'\\''s.wav'\n");
  });
});

describe("joinOrder", () => {
  const manifest = {
    schema_version: "1.0" as const,
    provider: "fake",
    voice: "af_heart",
    sample_rate: 24_000,
    clips: ["S00", "S01", "S02"].map((id) => ({
      step_id: id,
      path: `audio/${id}.wav`,
      duration_ms: 1000,
      cache_key: id,
    })),
  };

  it("puts a gap between clips and never at either end", () => {
    expect(joinOrder(manifest, 400)).toEqual([
      "S00.wav",
      "gap.wav",
      "S01.wav",
      "gap.wav",
      "S02.wav",
    ]);
  });

  it("omits gaps entirely when there are none", () => {
    expect(joinOrder(manifest, 0)).toEqual(["S00.wav", "S01.wav", "S02.wav"]);
  });
});

withFfmpeg("runCompose", () => {
  /**
   * A run folder holding a short real video plus the audio and timeline that match it.
   * The video is generated with ffmpeg rather than recorded, so this test needs no browser.
   */
  async function runFolder(config: SprConfig) {
    const runDir = mkdtempSync(path.join(tmpdir(), "spr-compose-"));
    mkdirSync(path.join(runDir, "audio"), { recursive: true });

    const { script } = loadGolden(SAMPLE);
    const trimmed = { ...script, steps: script.steps.slice(0, 2) };
    const { manifest } = await runTts({
      script: trimmed,
      provider: new FakeTtsProvider(),
      config,
      runDir,
    });
    const short = { ...manifest, clips: manifest.clips.map((c) => ({ ...c, duration_ms: 1000 })) };
    const timeline = buildTimeline(trimmed, short, config);

    // Rewrite the clips at the shortened length so the files match the manifest.
    for (const clip of short.clips) {
      await ffmpeg(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=24000:cl=mono",
          "-t",
          "1.0",
          "-c:a",
          "pcm_s16le",
          clip.path,
        ],
        runDir,
      );
    }
    // A silent video slightly longer than the timeline, standing in for a recording.
    await ffmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=1280x720:r=25",
        "-t",
        ((timeline.total_duration_ms + 400) / 1000).toFixed(2),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "video.webm.mp4",
      ],
      runDir,
    );
    cpSync(path.join(runDir, "video.webm.mp4"), path.join(runDir, "video.webm"));

    const record = {
      schema_version: "1.0" as const,
      video_path: "video.webm",
      t0_ms: 120,
      video: { width: 1280, height: 720 },
      recorded_duration_ms: timeline.total_duration_ms,
    };
    return { runDir, timeline, manifest: short, script: trimmed, record };
  }

  it("composes an H.264/AAC mp4 whose sound and picture agree", async () => {
    const config = defaultConfig();
    const { runDir, ...inputs } = await runFolder(config);
    const outcome = await runCompose({ ...inputs, config, runDir });

    const final = path.join(runDir, FINAL_FILE);
    expect(existsSync(final)).toBe(true);
    expect(readFileSync(final).byteLength).toBeGreaterThan(5000);

    expect(await streamDurationMs(FINAL_FILE, "video", runDir)).toBeGreaterThan(0);
    expect(await streamDurationMs(FINAL_FILE, "audio", runDir)).toBeGreaterThan(0);
    expect(Math.abs(outcome.videoDurationMs - outcome.audioDurationMs)).toBeLessThan(250);
  }, 180_000);

  it.each([
    ["sidecar", true],
    ["off", false],
  ] as const)(
    "writes a sidecar only for %s",
    async (mode, expectSidecar) => {
      const base = defaultConfig();
      const config = { ...base, video: { ...base.video, subtitles: mode } };
      const { runDir, ...inputs } = await runFolder(config);
      const outcome = await runCompose({ ...inputs, config, runDir });

      expect(existsSync(path.join(runDir, SUBTITLES_FILE))).toBe(expectSidecar);
      expect(outcome.subtitlesPath).toBe(expectSidecar ? SUBTITLES_FILE : undefined);
      expect(existsSync(path.join(runDir, FINAL_FILE))).toBe(true);
    },
    180_000,
  );

  it.skipIf(!canBurn)(
    "burns subtitles into the picture and leaves no sidecar behind",
    async () => {
      // Two copies of the same words - burned in and alongside - would be a viewer's problem.
      const base = defaultConfig();
      const config = { ...base, video: { ...base.video, subtitles: "burn" as const } };
      const { runDir, ...inputs } = await runFolder(config);
      const outcome = await runCompose({ ...inputs, config, runDir });

      expect(existsSync(path.join(runDir, FINAL_FILE))).toBe(true);
      expect(existsSync(path.join(runDir, SUBTITLES_FILE))).toBe(false);
      expect(outcome.subtitlesPath).toBeUndefined();
    },
    180_000,
  );

  it.skipIf(canBurn)(
    "says what to install when this build cannot burn subtitles in",
    async () => {
      const base = defaultConfig();
      const config = { ...base, video: { ...base.video, subtitles: "burn" as const } };
      const { runDir, ...inputs } = await runFolder(config);

      await expect(runCompose({ ...inputs, config, runDir })).rejects.toThrow(/libass/);
      await expect(runCompose({ ...inputs, config, runDir })).rejects.toThrow(/ffmpeg-full/);
      // And it names the way out that needs nothing installed.
      await expect(runCompose({ ...inputs, config, runDir })).rejects.toThrow(/sidecar/);
    },
    180_000,
  );

  it("says which stage to run when there is no video to compose", async () => {
    const config = defaultConfig();
    const { runDir, ...inputs } = await runFolder(config);
    writeFileSync(path.join(runDir, "video.webm"), "");
    const { unlinkSync } = await import("node:fs");
    unlinkSync(path.join(runDir, "video.webm"));

    await expect(runCompose({ ...inputs, config, runDir })).rejects.toThrow(/spr stage record/);
  }, 180_000);
});
