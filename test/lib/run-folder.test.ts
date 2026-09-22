import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRunFolder, RUN_OUTPUTS, runTimestamp } from "../../src/lib/run-folder.js";
import { INGEST_FILES } from "../../src/ingest/ingest.js";
import { REVIEW_RAW_FILE } from "../../src/agents/reviewer.js";
import { REVIEW_FILE } from "../../src/verify/verify.js";
import { REJECTED_SCRIPT_FILE, SCRIPT_FILE } from "../../src/agents/narrator.js";
import { AUDIO_DIR } from "../../src/tts/speak.js";
import { TIMELINE_FILE } from "../../src/director/direct.js";
import { PAGE_FILE } from "../../src/recorder/page.js";
import { RECORD_FILE, VIDEO_FILE } from "../../src/recorder/record.js";
import { FINAL_FILE, SUBTITLES_FILE } from "../../src/composer/compose.js";
import { COMMENT_FILE } from "../../src/publish/comment.js";
import { StageError } from "../../src/lib/errors.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spr-runs-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("runTimestamp", () => {
  it("is a compact UTC stamp with no punctuation", () => {
    expect(runTimestamp(new Date("2026-09-15T19:24:31.123Z"))).toBe("20260915T192431Z");
  });
});

describe("createRunFolder", () => {
  it("creates <runsDir>/<timestamp>-<id> and returns an absolute path", () => {
    const runsDir = tempDir();
    const dir = createRunFolder({
      runsDir,
      id: "abc1234",
      now: new Date("2026-09-15T19:24:31.000Z"),
    });
    expect(dir).toBe(path.join(runsDir, "20260915T192431Z-abc1234"));
    expect(existsSync(dir)).toBe(true);
  });

  it("uses --out when given, creating parents", () => {
    const out = path.join(tempDir(), "nested", "run");
    expect(createRunFolder({ runsDir: "runs", id: "x", out })).toBe(out);
    expect(existsSync(out)).toBe(true);
  });

  it("refuses a folder that already holds files, unless forced", () => {
    const out = tempDir();
    writeFileSync(path.join(out, "ingest.json"), "{}", "utf8");
    expect(() => createRunFolder({ runsDir: "runs", id: "x", out })).toThrow(StageError);
    expect(() => createRunFolder({ runsDir: "runs", id: "x", out })).toThrow("is not empty");
    expect(createRunFolder({ runsDir: "runs", id: "x", out, force: true })).toBe(out);
  });

  it("clears an earlier run's outputs when forced, and nothing else", () => {
    const out = tempDir();
    for (const name of ["review.json", "final.mp4", "trace.jsonl", "notes.txt"]) {
      writeFileSync(path.join(out, name), "old", "utf8");
    }
    mkdirSync(path.join(out, "audio"));
    writeFileSync(path.join(out, "audio", "S00.wav"), "old");
    mkdirSync(path.join(out, "mine"));

    createRunFolder({ runsDir: "runs", id: "x", out, force: true });
    expect(readdirSync(out).sort()).toEqual(["mine", "notes.txt"]);
  });

  it("names every file each stage writes", () => {
    const stageFiles = [
      ...Object.values(INGEST_FILES),
      REVIEW_RAW_FILE,
      REVIEW_FILE,
      SCRIPT_FILE,
      REJECTED_SCRIPT_FILE,
      AUDIO_DIR,
      TIMELINE_FILE,
      PAGE_FILE,
      VIDEO_FILE,
      RECORD_FILE,
      SUBTITLES_FILE,
      FINAL_FILE,
      COMMENT_FILE,
      "trace.jsonl",
      "cost.json",
    ];
    expect([...RUN_OUTPUTS].sort()).toEqual([...new Set(stageFiles)].sort());
  });

  it("accepts an existing but empty folder", () => {
    const out = tempDir();
    expect(createRunFolder({ runsDir: "runs", id: "x", out })).toBe(out);
  });
});
