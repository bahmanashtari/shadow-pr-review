/**
 * Walks every golden sample through the whole pipeline and prints what came out.
 *
 * Deliberately a script rather than a test (Milestone 2 step 6, Q1). A full run records in
 * real time and calls a model when the cache is cold, so three samples cost several minutes
 * of wall clock - which belongs in neither `pnpm test` nor the per-push CI job. This is the
 * thing somebody runs before a release, or after touching a stage boundary, and what it
 * prints is a row of numbers worth comparing against the last run rather than a pass or fail.
 *
 * It spawns the real CLI with no `--until`, because that exact path is the one nothing else
 * exercises: the unit test stops at `direct` (step 4 made recording real-time). Getting all
 * the way through Compose means exiting 2 at `publish`, so that is the expected outcome here,
 * not a failure. So is the other correct ending (ADR-042): a review that keeps no findings
 * stops after Verify with exit 0 and no video, which the restraint samples are meant to do.
 *
 *   pnpm tsx scripts/end-to-end.ts                       # every golden sample
 *   pnpm tsx scripts/end-to-end.ts sample-03-email-value-object
 *
 * Needs the whole toolchain up at once: `ollama serve` with the configured model, the Kokoro
 * container, ffmpeg, and Playwright's headless shell.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { fromRoot } from "../src/lib/paths.js";
import { countWords } from "../src/contracts/checks.js";
import { readScript } from "../src/agents/narrator.js";
import { readReview } from "../src/verify/verify.js";
import { readManifest } from "../src/tts/speak.js";
import { readTimeline } from "../src/director/direct.js";
import { readRecord } from "../src/recorder/record.js";
import { streamDurationMs } from "../src/composer/ffmpeg.js";
import { FINAL_FILE, SUBTITLES_FILE } from "../src/composer/compose.js";

/** The exit code `spr run` uses for a stage that is not built yet - here, `publish`. */
const NOT_IMPLEMENTED = 2;

/** What one sample's run produced, all of it read back off disk. */
interface Row {
  sample: string;
  ok: boolean;
  /** False for a clean review, which correctly ends without a video (ADR-042). */
  video: boolean;
  note: string;
  wallMs: number;
  kept: number;
  dropped: number;
  steps: number;
  words: number;
  audioMs: number;
  videoMs: number;
  /** The mp4's own video stream, per ffprobe - not what the Composer claimed. */
  probedVideoMs: number | undefined;
  /** The mp4's own audio stream, per ffprobe. */
  probedAudioMs: number | undefined;
  t0Ms: number;
  cues: number;
  bytes: number;
  cachedClips: number;
}

/** `56637` -> `0:57`. */
function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Every golden sample that has a diff, in name order. */
function allSamples(): string[] {
  return readdirSync(fromRoot("golden"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(fromRoot("golden", e.name, "diff.patch")))
    .map((e) => e.name)
    .sort();
}

/** Counts `-->` lines, which is one per subtitle cue. */
function countCues(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.includes("-->")).length;
}

/** Runs one sample end to end and reads the run folder back. */
async function walk(sample: string): Promise<Row> {
  const runDir = fromRoot("runs", `e2e-${sample}`);
  const diff = fromRoot("golden", sample, "diff.patch");
  console.log(`\n=== ${sample} ===`);
  // Start from an empty folder. `--force` writes over files but does not remove them, so a
  // sample that used to make a video and now finds nothing would otherwise leave the old
  // final.mp4 behind, and this script would read it as this run's.
  rmSync(runDir, { recursive: true, force: true });

  const started = Date.now();
  const result = await execa(
    "tsx",
    ["src/cli.ts", "run", "--diff", diff, "--out", runDir, "--force"],
    { cwd: fromRoot(), stdio: "inherit", reject: false, preferLocal: true },
  );
  const wallMs = Date.now() - started;

  const base: Row = {
    sample,
    ok: false,
    video: false,
    note: "",
    wallMs,
    kept: 0,
    dropped: 0,
    steps: 0,
    words: 0,
    audioMs: 0,
    videoMs: 0,
    probedVideoMs: undefined,
    probedAudioMs: undefined,
    t0Ms: 0,
    cues: 0,
    bytes: 0,
    cachedClips: 0,
  };

  const finalPath = path.join(runDir, FINAL_FILE);
  if (!existsSync(finalPath)) {
    const review =
      result.exitCode === 0 && existsSync(path.join(runDir, "review.json"))
        ? readReview(runDir)
        : null;
    if (review !== null && review.findings.length === 0) {
      return { ...base, ok: true, note: "no findings", dropped: review.dropped.length };
    }
    return { ...base, note: `no ${FINAL_FILE} (exit ${String(result.exitCode)})` };
  }
  if (result.exitCode !== NOT_IMPLEMENTED) {
    // 0 would mean publish exists now, which is a real change rather than a failure - but it
    // means this script's expectation is stale, so say so instead of quietly passing.
    return { ...base, note: `unexpected exit ${String(result.exitCode)}` };
  }

  const review = readReview(runDir);
  const script = readScript(runDir);
  const manifest = readManifest(runDir);
  const timeline = readTimeline(runDir);
  const record = readRecord(runDir);

  return {
    ...base,
    ok: true,
    video: true,
    kept: review.findings.length,
    dropped: review.dropped.length,
    steps: script.steps.length,
    words: script.steps.reduce((n, s) => n + countWords(s.text), 0),
    audioMs: manifest.clips.reduce((n, c) => n + c.duration_ms, 0),
    videoMs: timeline.total_duration_ms,
    probedVideoMs: await streamDurationMs(FINAL_FILE, "video", runDir),
    probedAudioMs: await streamDurationMs(FINAL_FILE, "audio", runDir),
    t0Ms: record.t0_ms,
    cues: countCues(path.join(runDir, SUBTITLES_FILE)),
    bytes: statSync(finalPath).size,
    cachedClips: manifest.clips.filter((c) => c.cached).length,
  };
}

/** The table, which is the point of the script. */
function table(rows: readonly Row[]): void {
  const head = [
    "sample",
    "final",
    "drift",
    "kept",
    "drop",
    "steps",
    "words",
    "w/step",
    "t0",
    "cues",
    "MB",
    "wall",
  ];
  const body = rows.map((r) => {
    const drift =
      r.probedVideoMs === undefined || r.probedAudioMs === undefined
        ? "-"
        : `${String(r.probedVideoMs - r.probedAudioMs)}ms`;
    return [
      r.sample,
      !r.ok ? "FAILED" : r.video ? clock(r.probedVideoMs ?? r.videoMs) : "none",
      r.ok && r.video ? drift : r.note,
      String(r.kept),
      String(r.dropped),
      String(r.steps),
      String(r.words),
      r.steps === 0 ? "-" : (r.words / r.steps).toFixed(1),
      r.video ? `${String(r.t0Ms)}ms` : "-",
      String(r.cues),
      (r.bytes / 1024 / 1024).toFixed(1),
      clock(r.wallMs),
    ];
  });

  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");

  console.log(`\n${line(head)}`);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

const requested = process.argv.slice(2);
const samples = requested.length > 0 ? requested : allSamples();

const rows: Row[] = [];
for (const sample of samples) rows.push(await walk(sample));

table(rows);

const failed = rows.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${String(failed.length)} of ${String(rows.length)} samples did not finish:`);
  for (const r of failed) console.error(`  ${r.sample}: ${r.note}`);
  process.exitCode = 1;
} else {
  const videos = rows.filter((r) => r.video).length;
  console.log(
    `\n${String(rows.length)} of ${String(rows.length)} samples finished: ` +
      `${String(videos)} with a video, ${String(rows.length - videos)} with nothing to narrate.`,
  );
}
