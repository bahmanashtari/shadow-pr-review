/**
 * The Record stage: the page and the timeline become `video.webm`.
 *
 * A thin driver over `schedule.ts`, which holds the arithmetic. What is left here is the part
 * that genuinely needs a browser: launch Chromium, record a context, wait for the page to be
 * ready, fire each action when it is due, and write down `t0`.
 *
 * `t0` is the reason `record.json` exists. Recording starts when the context is created, but
 * the timeline's clock starts when the page is drawn and tagged - and the page load in between
 * is in the video without being part of it. The Composer trims `t0` off the front before it
 * muxes the audio, otherwise every visual lands late against the narration.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright";
import type { RecordResult } from "../contracts/generated/record.js";
import type { Timeline } from "../contracts/generated/timeline.js";
import { assertContract, validateContract } from "../contracts/validate.js";
import { ContractError, StageError } from "../lib/errors.js";
import { buildPage, PAGE_FILE } from "./page.js";
import { actionsOf, tailFor, waitFor, type ScheduledAction } from "./schedule.js";

/** Files this stage writes. */
export const VIDEO_FILE = "video.webm";
export const RECORD_FILE = "record.json";

/** How long to wait for the page to draw a diff before giving up. */
const READY_TIMEOUT_MS = 60_000;

/** Input for {@link runRecord}. */
export interface RunRecordOptions {
  timeline: Timeline;
  /** The contents of `diff.patch`, which the page renders. */
  diffText: string;
  /** The title card's words, from `script.json`. */
  title: string;
  /** The outro card's words, from the review's finding summary. */
  outro: string;
  runDir: string;
  /** Called after each action, for the tests that check the live page. */
  onAction?: (action: ScheduledAction, page: Page) => Promise<void>;
}

/** What the stage produced. */
export interface RecordOutcome {
  result: RecordResult;
}

/**
 * Records the timeline.
 *
 * The context is closed on every path, including failure, because Playwright finalises the
 * video file when the context closes. A crash part-way through should still leave the frames it
 * managed to record - the failure modes here are environmental (no browser, a page that never
 * draws, a machine too loaded to keep the clock) and most of a video plus a clear message is far
 * more use than nothing.
 */
export async function runRecord(options: RunRecordOptions): Promise<RecordOutcome> {
  const { timeline, diffText, title, outro, runDir, onAction } = options;
  const { width, height } = timeline.video;

  const pageFile = path.join(runDir, PAGE_FILE);
  writeFileSync(pageFile, buildPage(diffText, { title, outro }), "utf8");
  mkdirSync(runDir, { recursive: true });

  const browser = await launch();
  let taken: Taken;
  try {
    taken = await drive(browser, { timeline, pageFile, runDir, ...(onAction ? { onAction } : {}) });
  } finally {
    await browser.close();
  }

  const { videoPath, t0Ms, recordedMs } = taken;
  if (videoPath === undefined) {
    throw new StageError("record", "Playwright recorded no video for this context.");
  }

  // Playwright names the file after an internal hash; the contract says `video.webm`.
  const finalPath = path.join(runDir, VIDEO_FILE);
  if (path.resolve(videoPath) !== path.resolve(finalPath)) renameSync(videoPath, finalPath);

  const result: RecordResult = {
    schema_version: "1.0",
    video_path: VIDEO_FILE,
    t0_ms: t0Ms,
    video: { width, height },
    recorded_duration_ms: recordedMs,
  };
  assertContract("record", result);
  return { result };
}

/** What one recording produced. */
interface Taken {
  videoPath: string | undefined;
  t0Ms: number;
  recordedMs: number;
}

/** Everything `drive` needs, so the outer function keeps no mutable state. */
interface DriveOptions {
  timeline: Timeline;
  pageFile: string;
  runDir: string;
  onAction?: (action: ScheduledAction, page: Page) => Promise<void>;
}

/**
 * Opens the page, executes the timeline, and hands back what was recorded.
 *
 * The context is closed in a `finally`, because Playwright finalises the video file on close:
 * without it, a failure part-way through leaves no file at all rather than most of one.
 */
async function drive(browser: Browser, options: DriveOptions): Promise<Taken> {
  const { timeline, pageFile, runDir, onAction } = options;
  const { width, height } = timeline.video;

  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: runDir, size: { width, height } },
  });
  const contextStarted = performance.now();

  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(pageFile).href);
    await page.waitForFunction(() => window.spr?.ready === true, undefined, {
      timeout: READY_TIMEOUT_MS,
    });

    // Everything from here is measured against this one origin, never chained: chaining the
    // gaps would accumulate every scheduler overshoot across the length of the video.
    const t0 = performance.now();

    for (const action of actionsOf(timeline)) {
      const wait = waitFor(action, performance.now() - t0);
      if (wait > 0) await sleep(wait);
      await page.evaluate((a) => {
        window.spr?.run(a);
      }, action);
      if (onAction) await onAction(action, page);
    }

    const tail = tailFor(timeline, performance.now() - t0);
    if (tail > 0) await sleep(tail);

    const video = page.video();
    return {
      videoPath: video === null ? undefined : await video.path(),
      t0Ms: Math.round(t0 - contextStarted),
      recordedMs: Math.round(performance.now() - t0),
    };
  } finally {
    await context.close();
  }
}

/** Launches Chromium, and says what to do when it is not installed. */
async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (cause) {
    throw new StageError(
      "record",
      `Cannot launch Chromium. Install it with ` +
        `\`pnpm exec playwright install chromium-headless-shell\`.`,
      { cause },
    );
  }
}

/** Reads and validates an existing `record.json`, which is what tells the Composer about t0. */
export function readRecord(runDir: string): RecordResult {
  const file = path.join(runDir, RECORD_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new StageError("compose", `Cannot read ${file}`, { cause });
  }
  const result = validateContract("record", parsed);
  if (!result.ok) throw new ContractError(file, result.errors);
  return result.value;
}

/** Writes `record.json` into a run folder. The video is already there. */
export function writeRecord(runDir: string, result: RecordResult): void {
  writeFileSync(path.join(runDir, RECORD_FILE), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

/** One line such as `video: 1280x720, 0:57 recorded, t0 132 ms`. */
export function summarizeRecord(outcome: RecordOutcome): string {
  const { video, recorded_duration_ms, t0_ms } = outcome.result;
  const seconds = Math.round(recorded_duration_ms / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `video: ${video.width}x${video.height}, ${clock} recorded, t0 ${t0_ms} ms`;
}
