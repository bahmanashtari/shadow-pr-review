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
  assertAudioComplete,
  assertInSync,
  assertScheduleAgrees,
  expectedAudioMs,
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

describe("expectedAudioMs", () => {
  const clips = (...durations: number[]) => ({
    schema_version: "1.0" as const,
    provider: "fake",
    voice: "af_heart",
    speed: 1,
    sample_rate: 24_000,
    clips: durations.map((duration_ms, i) => ({
      step_id: `S0${String(i)}`,
      path: `audio/S0${String(i)}.wav`,
      duration_ms,
      cache_key: "k",
      cached: false,
    })),
  });

  it("puts a gap between each pair of clips and none at either end", () => {
    // Four clips take three gaps, which is what `joinOrder` joins and what the schedule ends on.
    expect(expectedAudioMs(clips(1000, 2000, 3000, 4000), 400)).toBe(10_000 + 1200);
  });

  it("adds no gap at all for a single clip", () => {
    expect(expectedAudioMs(clips(1000), 400)).toBe(1000);
  });

  it("ignores the gap when there is none", () => {
    expect(expectedAudioMs(clips(1000, 2000), 0)).toBe(3000);
  });
});

describe("assertScheduleAgrees", () => {
  const manifest = {
    schema_version: "1.0" as const,
    provider: "fake",
    voice: "af_heart",
    speed: 1,
    sample_rate: 24_000,
    clips: [
      { step_id: "S00", path: "audio/S00.wav", duration_ms: 1000, cache_key: "a", cached: false },
      { step_id: "S01", path: "audio/S01.wav", duration_ms: 2000, cache_key: "b", cached: false },
    ],
  };
  const timeline = (lastEnd: number) => ({
    schema_version: "1.0" as const,
    render_mode: "diff2html" as const,
    video: { width: 1280, height: 720, theme: "dark" as const },
    gap_ms: 400,
    total_duration_ms: lastEnd + 400,
    step_windows: [
      { step_id: "S00", start_ms: 0, end_ms: 1000 },
      { step_id: "S01", start_ms: 1400, end_ms: lastEnd },
    ],
    actions: [],
  });

  it("accepts a schedule that ends where the clips and gaps do", () => {
    // 1000 + 400 + 2000.
    expect(() => {
      assertScheduleAgrees(manifest, timeline(3400));
    }).not.toThrow();
  });

  it("names both numbers and the stage that rebuilds one from the other", () => {
    // A timeline built before a clip was re-spoken is the way this happens.
    const error = (() => {
      try {
        assertScheduleAgrees(manifest, timeline(3900));
      } catch (e: unknown) {
        return e as StageError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(StageError);
    expect(error?.message).toContain("disagree by 500 ms");
    expect(error?.message).toContain("3900");
    expect(error?.message).toContain("3400");
    expect(error?.message).toContain("spr stage direct");
  });
});

describe("assertAudioComplete", () => {
  const base = { expectedMs: 56_237, trimmedVideoMs: 56_504, runDir: "/runs/x" };

  it("accepts the millisecond-level agreement a healthy run produces", () => {
    // The three complete runs behind ADR-034 landed 0.2, 1.0 and 0.7 ms off.
    expect(() => {
      assertAudioComplete({ ...base, finalAudioMs: 56_236 });
    }).not.toThrow();
  });

  it("blames the recording, and says how to redo it, when the picture came up short", () => {
    // ADR-034's numbers exactly: `-shortest` cut 429 ms of narration to fit a short webm.
    const error = (() => {
      try {
        assertAudioComplete({ ...base, finalAudioMs: 55_808, trimmedVideoMs: 55_826 });
      } catch (e: unknown) {
        return e as StageError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(StageError);
    expect(error?.message).toContain("429 ms of narration is missing");
    expect(error?.message).toContain("The recording is the cause");
    expect(error?.message).toContain("spr stage record --run /runs/x");
    // The point of keeping the folder: the model has already been paid for.
    expect(error?.message).toContain("re-reviewed or re-spoken");
  });

  it("blames the join instead when the picture was long enough", () => {
    const error = (() => {
      try {
        assertAudioComplete({ ...base, finalAudioMs: 55_808 });
      } catch (e: unknown) {
        return e as StageError;
      }
      return undefined;
    })();
    expect(error?.message).toContain("audio track itself came out short");
    expect(error?.message).toContain("audio/list.txt");
    expect(error?.message).not.toContain("The recording is the cause");
  });

  it("catches sound the schedule never allowed for", () => {
    const error = (() => {
      try {
        assertAudioComplete({ ...base, finalAudioMs: 57_000 });
      } catch (e: unknown) {
        return e as StageError;
      }
      return undefined;
    })();
    expect(error?.message).toContain("763 ms more sound than the schedule allows");
  });

  it("still fails when the recording cannot be probed at all", () => {
    // `trimmedVideoMs` only picks the wording; a missing duration must not excuse the shortfall.
    expect(() => {
      assertAudioComplete({ ...base, finalAudioMs: 55_808, trimmedVideoMs: undefined });
    }).toThrow(StageError);
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
   *
   * `videoMs` overrides how long that stand-in recording is. The default comfortably covers the
   * timeline; passing less reproduces the failure ADR-034 found, where Playwright wrote a webm
   * shorter than the narration and `-shortest` cut the sound to fit it.
   */
  async function runFolder(config: SprConfig, videoMs?: number) {
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
        ((videoMs ?? timeline.total_duration_ms + 400) / 1000).toFixed(2),
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

  /*
   * The regression this step exists for (ADR-034, ADR-035). Playwright wrote a webm 678 ms
   * shorter than the Recorder's own clock claimed, `-shortest` cut the narration to fit it, and
   * the old check called the result the best-synced file the project had produced - because the
   * two streams it compared had been made to agree by the encoder that truncated them.
   */
  it("refuses a video whose narration `-shortest` cut off, and says to re-record", async () => {
    const config = defaultConfig();
    // Two 1000 ms clips and one 400 ms gap need 2400 ms; this recording has far less.
    const { runDir, ...inputs } = await runFolder(config, 2000);

    await expect(runCompose({ ...inputs, config, runDir })).rejects.toThrow(/narration is missing/);
    await expect(runCompose({ ...inputs, config, runDir })).rejects.toThrow(
      /The recording is the cause/,
    );
    await expect(runCompose({ ...inputs, config, runDir })).rejects.toThrow(/spr stage record/);
  }, 180_000);

  it("says which stage to run when there is no video to compose", async () => {
    const config = defaultConfig();
    const { runDir, ...inputs } = await runFolder(config);
    writeFileSync(path.join(runDir, "video.webm"), "");
    const { unlinkSync } = await import("node:fs");
    unlinkSync(path.join(runDir, "video.webm"));

    await expect(runCompose({ ...inputs, config, runDir })).rejects.toThrow(/spr stage record/);
  }, 180_000);
});
