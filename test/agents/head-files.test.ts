import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderHeadFiles } from "../../src/agents/head-files.js";
import { runReview } from "../../src/agents/reviewer.js";
import { Budget } from "../../src/harness/budget.js";
import { Tracer } from "../../src/harness/tracing.js";
import { FakeLlmProvider, fakeText } from "../../src/providers/llm/fake.js";
import { defaultConfig, ingestOfDiff } from "../helpers.js";

const temps: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spr-head-"));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A diff that modifies line 3 of `src/client.ts` and deletes `src/old.ts`. */
const DIFF = [
  "diff --git a/src/client.ts b/src/client.ts",
  "index 1111111..2222222 100644",
  "--- a/src/client.ts",
  "+++ b/src/client.ts",
  "@@ -3,1 +3,1 @@",
  "-    this.initialized = undefined;",
  "+    this.initialized = null;",
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "index 3333333..0000000",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-export const gone = 1;",
  "",
].join("\n");

const CLIENT = [
  "export class Client {",
  "  protected initialized: Promise<void> | null = null;",
  "    this.initialized = null;",
  "}",
  "",
].join("\n");

describe("renderHeadFiles (step 21)", () => {
  it("shows each changed file whole at the head, numbered like the diff, and skips deletions", () => {
    const text = renderHeadFiles(ingestOfDiff(DIFF), repo({ "src/client.ts": CLIENT }));
    expect(text).toContain("for reading only");
    expect(text).toContain("--- whole file at head: src/client.ts (4 lines) ---");
    // The declaration above the hunk - what ADR-060's second false positive needed to see.
    expect(text).toContain("   2    protected initialized: Promise<void> | null = null;");
    expect(text).not.toContain("old.ts");
  });

  it("cuts a file over its cap at a line boundary, and says where", () => {
    const long = Array.from({ length: 50 }, (_, i) => `const line${String(i + 1)} = ${String(i)};`);
    const text = renderHeadFiles(ingestOfDiff(DIFF), repo({ "src/client.ts": long.join("\n") }), {
      perFileBytes: 300,
    });
    expect(text).toMatch(/src\/client\.ts \(50 lines, cut after line \d+\)/);
    expect(text).not.toContain("line50");
  });

  it("gives the smaller file its share first, so the large one is the one cut", () => {
    const two = [
      "diff --git a/big.ts b/big.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/big.ts",
      "@@ -0,0 +1 @@",
      "+x",
      "diff --git a/small.ts b/small.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/small.ts",
      "@@ -0,0 +1 @@",
      "+y",
      "",
    ].join("\n");
    const big = Array.from(
      { length: 40 },
      (_, i) => `export const big${String(i)} = ${String(i)};`,
    );
    const text = renderHeadFiles(
      ingestOfDiff(two),
      repo({ "big.ts": big.join("\n"), "small.ts": "export const small = 1;\n" }),
      { perFileBytes: 10_000, totalBytes: 400 },
    );
    expect(text).toContain("--- whole file at head: small.ts (1 lines) ---");
    expect(text).toMatch(/big\.ts \(40 lines, cut after line \d+\)/);
    // Rendered in the diff's order, whatever order the budget was handed out in.
    expect(text.indexOf("big.ts")).toBeLessThan(text.indexOf("small.ts"));
  });

  it("says a file could not be read instead of failing the review", () => {
    const text = renderHeadFiles(ingestOfDiff(DIFF), repo({}));
    expect(text).toContain("--- whole file at head: src/client.ts (could not be read) ---");
  });

  it("puts the files in the Reviewer's user message with a checkout, and nowhere without one", async () => {
    const answer = fakeText(JSON.stringify({ summary: "s", findings: [] }));
    const request = async (repoRoot?: string) => {
      const provider = new FakeLlmProvider([answer]);
      await runReview({
        ingest: ingestOfDiff(DIFF),
        provider,
        config: defaultConfig(),
        budget: new Budget(defaultConfig().budgets),
        tracer: new Tracer(),
        ...(repoRoot === undefined ? {} : { repoRoot }),
      });
      return provider.requests[0];
    };
    const withCheckout = await request(repo({ "src/client.ts": CLIENT }));
    expect(JSON.stringify(withCheckout?.messages)).toContain("whole file at head");
    // Untrusted content: never in the system prompt (ADR-049).
    expect(withCheckout?.system).not.toContain("Promise<void> | null");

    const diffOnly = await request();
    expect(JSON.stringify(diffOnly?.messages)).not.toContain("whole file at head");
  });
});
