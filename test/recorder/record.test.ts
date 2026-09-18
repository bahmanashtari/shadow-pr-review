/**
 * The one test that needs a real browser, kept deliberately small.
 *
 * Everything about timing lives in `schedule.test.ts` and runs without Chromium. What is left
 * here is what only a browser can answer: that a WebM comes out, and that the page really did
 * what each action asked while it was being recorded.
 *
 * That second half is the valuable one. It catches the bugs that are *ours* - a timeline firing
 * the wrong action, a selector that stopped matching - while whether the WebM is well encoded
 * is Playwright's problem, covered by the magic-byte check. The video's real duration is not
 * checked here at all: that needs ffprobe, which ADR-027 keeps out until the Composer.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { runRecord, RECORD_FILE, VIDEO_FILE, writeRecord } from "../../src/recorder/record.js";
import { highlightRowCount } from "../../src/recorder/schedule.js";
import { buildTimeline } from "../../src/director/timeline.js";
import { runTts } from "../../src/tts/speak.js";
import { FakeTtsProvider } from "../../src/providers/tts/fake.js";
import { validateContract } from "../../src/contracts/validate.js";
import { defaultConfig, loadGolden, readGoldenDiff } from "../helpers.js";

const SAMPLE = "sample-01-order-outbox";

/** The first four bytes of any WebM: the EBML magic number. */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/**
 * Whether a browser is installed. A contributor who has not run `playwright install` should
 * still get a green suite and a clear reason, rather than a failure they did not cause.
 */
async function browserAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const hasBrowser = await browserAvailable();
const withBrowser = hasBrowser ? describe : describe.skip;

if (!hasBrowser) {
  console.warn(
    "[record.test] no Chromium: skipping the recording test. " +
      "Install it with `pnpm exec playwright install chromium-headless-shell`.",
  );
}

withBrowser("runRecord", () => {
  /** A short timeline over the golden script, so the test records seconds rather than a minute. */
  async function shortTimeline() {
    const { script, review } = loadGolden(SAMPLE);
    const trimmed = { ...script, steps: script.steps.slice(0, 2) };
    const { manifest } = await runTts({
      script: trimmed,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir: mkdtempSync(path.join(tmpdir(), "spr-rec-tts-")),
    });
    // Shrink every window so the recording takes about two seconds, not ninety.
    const short = {
      ...manifest,
      clips: manifest.clips.map((c) => ({ ...c, duration_ms: 900 })),
    };
    return { timeline: buildTimeline(trimmed, short, defaultConfig()), review };
  }

  it(
    "records a WebM and reports where the timeline started",
    // Recording runs in real time, so this needs longer than the default.
    { timeout: 120_000 },
    async () => {
      const runDir = mkdtempSync(path.join(tmpdir(), "spr-rec-"));
      const { timeline } = await shortTimeline();

      // Assert the live page as it is being driven: this is the part that is ours to get wrong.
      const seen: { expected: number; actual: number }[] = [];
      const { result } = await runRecord({
        timeline,
        diffText: readGoldenDiff(SAMPLE),
        runDir,
        onAction: async (action, page) => {
          const expected = highlightRowCount(action);
          if (expected === undefined) return;
          const actual = await page.evaluate(() => document.querySelectorAll("tr.spr-hl").length);
          seen.push({ expected, actual });
        },
      });

      // The file exists, is a WebM, and is not a stub.
      const video = path.join(runDir, VIDEO_FILE);
      expect(existsSync(video)).toBe(true);
      expect(readFileSync(video).subarray(0, 4).equals(EBML_MAGIC)).toBe(true);
      expect(readFileSync(video).byteLength).toBeGreaterThan(10_000);

      // Playwright names the file after an internal hash; it must end up at the contract's name.
      expect(result.video_path).toBe(VIDEO_FILE);
      expect(result.t0_ms).toBeGreaterThanOrEqual(0);
      expect(result.video).toEqual({ width: 1280, height: 720 });
      expect(result.recorded_duration_ms).toBeGreaterThan(0);

      // The page was really driven: every highlight lit exactly the rows it asked for.
      expect(seen.length).toBeGreaterThan(0);
      for (const { expected, actual } of seen) expect(actual).toBe(expected);

      writeRecord(runDir, result);
      const onDisk: unknown = JSON.parse(readFileSync(path.join(runDir, RECORD_FILE), "utf8"));
      const validated = validateContract("record", onDisk);
      expect(validated.ok ? [] : validated.errors).toEqual([]);
    },
  );
});
