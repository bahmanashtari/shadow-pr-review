import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIngest, summarize, writeIngest, INGEST_FILES } from "../../src/ingest/ingest.js";
import { checkIngest } from "../../src/contracts/checks.js";
import { validateContract } from "../../src/contracts/validate.js";
import type { Source } from "../../src/contracts/generated/ingest.js";
import { configWithIngest, defaultConfig, readGoldenDiff } from "../helpers.js";

const SOURCE: Source = {
  type: "local_diff",
  repo: null,
  pr_number: null,
  ref: null,
  base_sha: null,
  head_sha: null,
  title: null,
};

/** A one-hunk "new file" block of a predictable size. */
function block(file: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+const v${i} = ${i};`).join("\n");
  return (
    `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..1111111\n` +
    `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${body}\n`
  );
}

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spr-ingest-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("buildIngest", () => {
  it("keeps every file of a golden sample and can rebuild the patch", () => {
    const rawDiff = readGoldenDiff("sample-02-inventory-consumer");
    const { ingest, keptPatch } = buildIngest({ rawDiff, source: SOURCE, config: defaultConfig() });

    expect(validateContract("ingest", ingest).ok).toBe(true);
    expect(checkIngest(ingest)).toEqual([]);
    expect(ingest.skipped).toEqual([]);
    expect(keptPatch).toBe(rawDiff);
    expect(ingest.diff.sha256).toBe(ingest.diff.raw_sha256);
    expect(ingest.diff.truncated).toBe(false);
    expect(ingest.stats).toEqual({
      files_total: 2,
      files_kept: 2,
      files_skipped: 0,
      additions: 31,
      deletions: 0,
    });
  });

  it("scores kept files and records skipped ones in diff order", () => {
    const rawDiff =
      block("src/app.ts", 2) + block("pnpm-lock.yaml", 2) + block("src/domain/order.ts", 2);
    const { ingest, keptPatch } = buildIngest({ rawDiff, source: SOURCE, config: defaultConfig() });

    expect(ingest.files.map((f) => [f.path, f.risk_score])).toEqual([
      ["src/app.ts", 1],
      ["src/domain/order.ts", 5],
    ]);
    expect(ingest.skipped).toEqual([
      { file: "pnpm-lock.yaml", status: "added", reason: "lockfile" },
    ]);
    expect(keptPatch).toBe(block("src/app.ts", 2) + block("src/domain/order.ts", 2));
  });

  it("keeps the riskiest files when the diff is over budget, still in diff order", () => {
    const docs = block("docs/guide.md", 4);
    const app = block("src/app.ts", 4);
    const domain = block("src/domain/order.ts", 4);
    const rawDiff = docs + app + domain;
    const config = configWithIngest({
      maxDiffBytes: Buffer.byteLength(app) + Buffer.byteLength(domain),
    });

    const { ingest, keptPatch } = buildIngest({ rawDiff, source: SOURCE, config });
    expect(ingest.files.map((f) => f.path)).toEqual(["src/app.ts", "src/domain/order.ts"]);
    expect(ingest.skipped).toEqual([
      { file: "docs/guide.md", status: "added", reason: "too_large" },
    ]);
    expect(ingest.diff.truncated).toBe(true);
    expect(keptPatch).toBe(app + domain);
  });

  it("skips a file that does not fit and carries on with the next one", () => {
    const huge = block("src/domain/order.ts", 200);
    const app = block("src/app.ts", 2);
    const docs = block("docs/guide.md", 2);
    const config = configWithIngest({
      maxDiffBytes: Buffer.byteLength(app) + Buffer.byteLength(docs),
    });

    const { ingest } = buildIngest({ rawDiff: huge + app + docs, source: SOURCE, config });
    expect(ingest.files.map((f) => f.path)).toEqual(["src/app.ts", "docs/guide.md"]);
    expect(ingest.skipped.map((s) => [s.file, s.reason])).toEqual([
      ["src/domain/order.ts", "too_large"],
    ]);
    expect(ingest.diff.truncated).toBe(true);
  });

  it("breaks ties by path so the result never depends on iteration order", () => {
    const a = block("src/domain/a.ts", 4);
    const b = block("src/domain/b.ts", 4);
    const config = configWithIngest({ maxDiffBytes: Buffer.byteLength(a) });
    const { ingest } = buildIngest({ rawDiff: b + a, source: SOURCE, config });
    expect(ingest.files.map((f) => f.path)).toEqual(["src/domain/a.ts"]);
  });

  it("rejects a diff whose hunk header does not match its lines", () => {
    expect(() =>
      buildIngest({
        rawDiff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,5 +1,5 @@\n a\n",
        source: SOURCE,
        config: defaultConfig(),
      }),
    ).toThrow(/header promised more/);
  });
});

describe("writeIngest", () => {
  it("writes the three files and repeats byte for byte", () => {
    const rawDiff = readGoldenDiff("sample-01-order-outbox");
    const config = defaultConfig();

    const first = tempDir();
    writeIngest(first, rawDiff, buildIngest({ rawDiff, source: SOURCE, config }));
    const second = tempDir();
    writeIngest(second, rawDiff, buildIngest({ rawDiff, source: SOURCE, config }));

    for (const name of Object.values(INGEST_FILES)) {
      const a = readFileSync(path.join(first, name), "utf8");
      const b = readFileSync(path.join(second, name), "utf8");
      expect(a).toBe(b);
    }
    expect(readFileSync(path.join(first, INGEST_FILES.raw), "utf8")).toBe(rawDiff);
    expect(readFileSync(path.join(first, INGEST_FILES.json), "utf8").endsWith("}\n")).toBe(true);
  });
});

describe("summarize", () => {
  it("counts kept and skipped files by reason", () => {
    const rawDiff =
      block("src/app.ts", 2) + block("pnpm-lock.yaml", 2) + block("src/api/generated/c.ts", 2);
    const { ingest } = buildIngest({ rawDiff, source: SOURCE, config: defaultConfig() });
    expect(summarize(ingest)).toBe("3 files: 1 kept (+2 -0), 2 skipped (1 lockfile, 1 generated)");
  });

  it("says when the diff was cut down to fit the budget", () => {
    const app = block("src/app.ts", 4);
    const config = configWithIngest({ maxDiffBytes: Buffer.byteLength(app) });
    const { ingest } = buildIngest({
      rawDiff: app + block("docs/guide.md", 4),
      source: SOURCE,
      config,
    });
    expect(summarize(ingest)).toContain("riskiest files only");
  });

  it("uses the singular for one file", () => {
    const { ingest } = buildIngest({
      rawDiff: block("src/app.ts", 1),
      source: SOURCE,
      config: defaultConfig(),
    });
    expect(summarize(ingest)).toBe("1 file: 1 kept (+1 -0)");
  });
});
