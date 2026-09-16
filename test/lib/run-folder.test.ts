import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRunFolder, runTimestamp } from "../../src/lib/run-folder.js";
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

  it("accepts an existing but empty folder", () => {
    const out = tempDir();
    expect(createRunFolder({ runsDir: "runs", id: "x", out })).toBe(out);
  });
});
