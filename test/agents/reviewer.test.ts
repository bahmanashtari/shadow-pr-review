import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  reviewerOutputSchema,
  runReview,
  summarizeReview,
  type ReviewOutcome,
} from "../../src/agents/reviewer.js";
import { renderDiff } from "../../src/agents/diff-view.js";
import { buildReviewerPrompt, readRubric } from "../../src/agents/prompts/reviewer.js";
import { buildReviewTools, resolveInsideRepo } from "../../src/agents/tools/review-tools.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { HunkIndex } from "../../src/ingest/hunk-index.js";
import { Budget } from "../../src/harness/budget.js";
import { Tracer } from "../../src/harness/tracing.js";
import { FakeLlmProvider, fakeText } from "../../src/providers/llm/fake.js";
import { validateContract } from "../../src/contracts/validate.js";
import { checkReview } from "../../src/contracts/checks.js";
import type { IngestResult, Source } from "../../src/contracts/generated/ingest.js";
import { GOLDEN_SAMPLES, defaultConfig, readGoldenDiff } from "../helpers.js";

const SOURCE: Source = {
  type: "local_diff",
  repo: null,
  pr_number: null,
  ref: null,
  base_sha: null,
  head_sha: null,
  title: null,
};

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spr-review-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function ingestOf(sample: string): IngestResult {
  return buildIngest({
    rawDiff: readGoldenDiff(sample),
    source: SOURCE,
    config: defaultConfig(),
  }).ingest;
}

const HANDLER = "services/order-service/src/application/commands/place-order.handler.ts";

/** Runs the stage with a scripted model answer. */
async function review(
  sample: string,
  answer: unknown,
  over: { repoRoot?: string; budget?: Budget } = {},
): Promise<ReviewOutcome> {
  const provider = new FakeLlmProvider([fakeText(JSON.stringify(answer))]);
  return runReview({
    ingest: ingestOf(sample),
    provider,
    config: defaultConfig(),
    budget: over.budget ?? new Budget(defaultConfig().budgets),
    tracer: new Tracer(),
    ...(over.repoRoot === undefined ? {} : { repoRoot: over.repoRoot }),
  });
}

const MODEL_FINDING = {
  file: HANDLER,
  side: "new",
  line_start: 22,
  line_end: 26,
  severity: "high",
  category: "event-consistency",
  summary: "Event is published before the transaction commits",
  rationale:
    "The emit runs inside the transaction callback, so consumers can see an order that never commits.",
  suggestion: "Write an outbox row in the same transaction and publish after commit.",
  confidence: 0.9,
  evidence: ["this.broker.emit('order.placed', {"],
};

describe("renderDiff", () => {
  it("shows the line number the Reviewer must cite", () => {
    const rendered = renderDiff(ingestOf("sample-01-order-outbox"));
    expect(rendered).toContain("--- file: " + HANDLER + " (added) risk 5 ---");
    expect(rendered).toContain("  19 +    await this.dataSource.transaction(async (manager) => {");
    expect(rendered).toContain("@@ hunk: new lines 1..31 @@");
  });

  it("agrees with HunkIndex about every numbered line", () => {
    for (const sample of GOLDEN_SAMPLES) {
      const ingest = ingestOf(sample);
      const index = HunkIndex.fromIngest(ingest);
      for (const line of renderDiff(ingest).split("\n")) {
        const match = /^\s*(\d+) ([+ ])(.*)$/.exec(line);
        if (!match) continue;
        const number = Number(match[1]);
        const file = ingest.files[0]?.path ?? "";
        if (ingest.files.length === 1) {
          expect(index.lineText(file, "new", number)).toBe(match[3]);
        }
      }
    }
  });

  it("is deterministic", () => {
    const ingest = ingestOf("sample-02-inventory-consumer");
    expect(renderDiff(ingest)).toBe(renderDiff(ingest));
  });

  it("says which files were not shown", () => {
    const ingest = ingestOf("sample-01-order-outbox");
    const withSkip: IngestResult = {
      ...ingest,
      skipped: [{ file: "pnpm-lock.yaml", status: "added", reason: "lockfile" }],
    };
    expect(renderDiff(withSkip)).toContain("pnpm-lock.yaml (lockfile)");
  });
});

describe("buildReviewerPrompt", () => {
  it("carries the rubric verbatim", () => {
    const prompt = buildReviewerPrompt();
    expect(prompt).toContain(readRubric());
  });

  it("states the rules the trial proved load-bearing", () => {
    const prompt = buildReviewerPrompt();
    expect(prompt).toContain("line_start and line_end must be numbers you can actually see");
    expect(prompt).toContain("copied\nexactly from the diff");
    // Severity anchoring: thinking rated a high-severity issue medium without it.
    expect(prompt).toContain("Do not rate those medium.");
  });

  it("lists analyzer findings as already reported", () => {
    const prompt = buildReviewerPrompt({ analyzerFindings: "- a.ts:1 [high/ddd-boundaries] x" });
    expect(prompt).toContain("Already reported");
    expect(prompt).toContain("Do not repeat them");
  });

  it("says when there is no checkout", () => {
    expect(buildReviewerPrompt({ hasRepository: false })).toContain("You have the diff only");
    expect(buildReviewerPrompt({ hasRepository: true })).not.toContain("You have the diff only");
  });

  it("contains no diff content", () => {
    expect(buildReviewerPrompt()).not.toContain("this.broker.emit");
  });
});

describe("buildReviewTools", () => {
  it("offers only the diff tools when there is no checkout", () => {
    const tools = buildReviewTools({ ingest: ingestOf("sample-01-order-outbox") });
    expect(tools.definitions().map((d) => d.name)).toEqual(["list_changed_files", "get_diff_hunk"]);
  });

  it("adds the repository tools when there is one", () => {
    const tools = buildReviewTools({
      ingest: ingestOf("sample-01-order-outbox"),
      repoRoot: "/tmp",
    });
    expect(tools.definitions().map((d) => d.name)).toEqual([
      "list_changed_files",
      "get_diff_hunk",
      "read_file",
      "grep_repo",
    ]);
  });

  it("lists the changed files with their risk", async () => {
    const tools = buildReviewTools({ ingest: ingestOf("sample-02-inventory-consumer") });
    const outcome = await tools.dispatch("list_changed_files", {});
    expect(outcome.content).toContain("order-placed.consumer.ts (added) risk 5");
    expect(outcome.isError).toBe(false);
  });

  it("returns a file's hunks, and says so when the file is not in the diff", async () => {
    const tools = buildReviewTools({ ingest: ingestOf("sample-01-order-outbox") });
    const found = await tools.dispatch("get_diff_hunk", { file: HANDLER });
    expect(found.content).toContain("  19 +");
    const missing = await tools.dispatch("get_diff_hunk", { file: "nope.ts" });
    expect(missing.content).toContain('No file "nope.ts"');
  });

  it("reads a file inside the checkout", async () => {
    const repo = tempDir();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "a.ts"), "one\ntwo\nthree\n", "utf8");
    const tools = buildReviewTools({ ingest: ingestOf("sample-01-order-outbox"), repoRoot: repo });
    const outcome = await tools.dispatch("read_file", { path: "src/a.ts", start: 2, end: 3 });
    expect(outcome.content).toBe("   2 two\n   3 three");
  });

  it("refuses a path that escapes the checkout", async () => {
    const repo = tempDir();
    const tools = buildReviewTools({ ingest: ingestOf("sample-01-order-outbox"), repoRoot: repo });
    const outcome = await tools.dispatch("read_file", {
      path: "../../etc/passwd",
      start: 1,
      end: 1,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("escapes the repository");
  });

  it("resolveInsideRepo allows inside and rejects outside", () => {
    expect(resolveInsideRepo("/repo", "src/a.ts")).toBe(path.resolve("/repo/src/a.ts"));
    expect(() => resolveInsideRepo("/repo", "../secret")).toThrow(/escapes the repository/);
    expect(() => resolveInsideRepo("/repo", "/etc/passwd")).toThrow(/escapes the repository/);
  });
});

describe("reviewerOutputSchema", () => {
  it("drops the fields the code owns and caps the findings", () => {
    const schema = reviewerOutputSchema(15);
    const properties0 = schema.properties as Record<string, Record<string, unknown>>;
    const findings = properties0.findings;
    if (!findings) throw new Error("schema has no findings property");
    const item = findings.items as Record<string, unknown>;
    const properties = item.properties as Record<string, unknown>;
    expect(properties.id).toBeUndefined();
    expect(properties.verification).toBeUndefined();
    expect(properties.evidence).toBeDefined();
    expect(item.required).not.toContain("id");
    expect(findings.maxItems).toBe(15);
  });
});

describe("runReview", () => {
  it("merges analyzer and model findings into a valid review", async () => {
    const outcome = await review("sample-01-order-outbox", {
      summary: "Adds a command handler that publishes an event inside a transaction.",
      findings: [MODEL_FINDING],
    });

    expect(validateContract("review", outcome.review).ok).toBe(true);
    expect(checkReview(outcome.review)).toEqual([]);
    expect(outcome.analyzerFindings).toBe(2);
    expect(outcome.modelFindings).toBe(1);
    expect(outcome.review.findings.map((f) => f.id)).toEqual(["F01", "F02", "F03"]);
    // Severity order: the model's high finding comes before the analyzers' medium ones.
    expect(outcome.review.findings.map((f) => f.severity)).toEqual(["high", "medium", "medium"]);
  });

  it("copies the source and the file stats from ingest", async () => {
    const outcome = await review("sample-01-order-outbox", { summary: "x", findings: [] });
    expect(outcome.review.source).toEqual(SOURCE);
    expect(outcome.review.stats).toEqual({ files_reviewed: 1, files_skipped: [] });
  });

  it("drops a model finding that repeats an analyzer finding", async () => {
    const duplicate = {
      ...MODEL_FINDING,
      line_start: 2,
      line_end: 2,
      category: "ddd-boundaries",
      severity: "medium",
      summary: "Application layer imports TypeORM",
      evidence: ["import { DataSource } from 'typeorm';"],
    };
    const outcome = await review("sample-01-order-outbox", {
      summary: "x",
      findings: [duplicate],
    });
    expect(outcome.analyzerFindings).toBe(2);
    expect(outcome.modelFindings).toBe(0);
  });

  it("still produces a review when a budget stops the model", async () => {
    const budget = new Budget({ ...defaultConfig().budgets, agentSteps: 1 });
    budget.addStep();
    const outcome = await runReview({
      ingest: ingestOf("sample-01-order-outbox"),
      provider: new FakeLlmProvider([]),
      config: defaultConfig(),
      budget,
      tracer: new Tracer(),
    });

    expect(outcome.stopped).toBe("budget:agentSteps");
    expect(outcome.review.findings).toHaveLength(2); // the analyzers still ran
    expect(outcome.review.summary).toContain("has not been fully reviewed");
    expect(checkReview(outcome.review)).toEqual([]);
  });

  it("grounds every finding it emits, for every golden sample", async () => {
    for (const sample of GOLDEN_SAMPLES) {
      const ingest = ingestOf(sample);
      const index = HunkIndex.fromIngest(ingest);
      const outcome = await runReview({
        ingest,
        provider: new FakeLlmProvider([fakeText(JSON.stringify({ summary: "s", findings: [] }))]),
        config: defaultConfig(),
        budget: new Budget(defaultConfig().budgets),
        tracer: new Tracer(),
      });
      for (const finding of outcome.review.findings) {
        expect(index.hasRange(finding.file, "new", finding.line_start, finding.line_end)).toBe(
          true,
        );
        for (const snippet of finding.evidence) {
          expect(index.containsSnippet(finding.file, snippet)).toBe(true);
        }
      }
    }
  });

  it("tells the model what the analyzers already found", async () => {
    const provider = new FakeLlmProvider([
      fakeText(JSON.stringify({ summary: "s", findings: [] })),
    ]);
    await runReview({
      ingest: ingestOf("sample-01-order-outbox"),
      provider,
      config: defaultConfig(),
      budget: new Budget(defaultConfig().budgets),
      tracer: new Tracer(),
    });
    const system = provider.requests[0]?.system ?? "";
    expect(system).toContain("Already reported");
    expect(system).toContain("Application layer depends directly on the ORM");
  });
});

describe("summarizeReview", () => {
  it("counts each source of findings", async () => {
    const outcome = await review("sample-01-order-outbox", {
      summary: "x",
      findings: [MODEL_FINDING],
    });
    expect(summarizeReview(outcome)).toBe("3 findings: 2 from checks, 1 from the model");
  });
});
