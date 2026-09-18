import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkReview } from "../../src/contracts/checks.js";
import type { SprConfig } from "../../src/contracts/generated/config.js";
import type { Finding, ReviewResult } from "../../src/contracts/generated/review.js";
import { validateContract } from "../../src/contracts/validate.js";
import { ContractError, StageError } from "../../src/lib/errors.js";
import type { Verdict } from "../../src/agents/verifier.js";
import {
  readRawReview,
  REVIEW_FILE,
  runVerify,
  summarizeVerify,
  writeVerifiedReview,
} from "../../src/verify/verify.js";
import {
  defaultConfig,
  GOLDEN_SAMPLES,
  ingestOfDiff,
  readGoldenDiff,
  readGoldenJson,
} from "../helpers.js";

const SAMPLE = "sample-01-order-outbox";
const HANDLER = "services/order-service/src/application/commands/place-order.handler.ts";
const TRANSACTION = "await this.dataSource.transaction(async (manager) => {";
const ingest = ingestOfDiff(readGoldenDiff(SAMPLE));

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spr-verify-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F01",
    file: HANDLER,
    side: "new",
    line_start: 19,
    line_end: 20,
    severity: "high",
    category: "event-consistency",
    summary: "Event published before commit",
    rationale: "The emit runs inside the transaction callback.",
    suggestion: "Use a transactional outbox.",
    confidence: 0.9,
    evidence: [TRANSACTION],
    ...over,
  };
}

function rawReview(findings: Finding[], dropped: ReviewResult["dropped"] = []): ReviewResult {
  return {
    schema_version: "1.0",
    source: ingest.source,
    summary: "Adds a command handler that saves an order and publishes an event.",
    findings,
    dropped,
    stats: { files_reviewed: 1, files_skipped: [] },
  };
}

/** The shipped defaults with a different cap, for the `over_cap` cases. */
function configWithCap(maxFindings: number): SprConfig {
  const config = defaultConfig();
  return { ...config, review: { ...config.review, maxFindings } };
}

async function verify(review: ReviewResult, config: SprConfig = defaultConfig()) {
  return await runVerify({ ingest, review, config });
}

describe("runVerify", () => {
  it("keeps the ids the Reviewer assigned, gaps and all", async () => {
    const review = rawReview([
      finding({ id: "F01", line_start: 40, line_end: 40 }),
      finding({ id: "F02" }),
    ]);
    const outcome = await verify(review);

    expect(outcome.review.findings.map((f) => f.id)).toEqual(["F02"]);
    expect(outcome.review.dropped.map((d) => d.id)).toEqual(["F01"]);
  });

  it("marks a finding that passed the checks as verified", async () => {
    const outcome = await verify(rawReview([finding()]));
    expect(outcome.review.findings[0]?.verification).toEqual({ status: "verified" });
  });

  it("leaves a verdict that is already on the finding alone", async () => {
    const downgraded = finding({
      severity: "medium",
      verification: { status: "downgraded", original_severity: "high", note: "rollback only" },
    });
    const outcome = await verify(rawReview([downgraded]));
    expect(outcome.review.findings[0]?.verification).toEqual(downgraded.verification);
  });

  it("records the reason and a usable note for each dropped finding", async () => {
    const review = rawReview([
      finding({ id: "F01", file: "services/order-service/src/main.ts" }),
      finding({ id: "F02", line_start: 40, line_end: 41 }),
      finding({ id: "F03", evidence: ["this line is invented"] }),
      finding({ id: "F04", line_start: 19, line_end: 27 }),
      finding({ id: "F05", line_start: 20, line_end: 22, severity: "low" }),
    ]);
    const outcome = await verify(review);

    expect(outcome.review.findings.map((f) => f.id)).toEqual(["F04"]);
    expect(outcome.review.dropped.map((d) => [d.id, d.reason])).toEqual([
      ["F01", "out_of_scope"],
      ["F02", "lines_not_in_diff"],
      ["F03", "claim_not_supported"],
      ["F05", "duplicate"],
    ]);
    expect(outcome.review.dropped[2]?.note).toContain("this line is invented");
    expect(outcome.review.dropped[0]?.line_start).toBe(19);
    expect(outcome.review.dropped[0]?.summary).toBe("Event published before commit");
  });

  it("drops what does not fit the cap, lowest severity first", async () => {
    const review = rawReview([
      finding({ id: "F01", severity: "low", line_start: 1, line_end: 1 }),
      finding({ id: "F02", severity: "critical", line_start: 3, line_end: 3 }),
      finding({ id: "F03", severity: "medium", line_start: 5, line_end: 5 }),
    ]);
    const outcome = await verify(review, configWithCap(2));

    expect(outcome.review.findings.map((f) => f.id)).toEqual(["F02", "F03"]);
    expect(outcome.review.dropped).toEqual([
      expect.objectContaining({ id: "F01", reason: "over_cap" }),
    ]);
  });

  it("orders the kept findings by severity, then file and line", async () => {
    const review = rawReview([
      finding({ id: "F01", severity: "low", line_start: 22, line_end: 22 }),
      finding({ id: "F02", severity: "critical", line_start: 12, line_end: 12 }),
      finding({ id: "F03", severity: "low", line_start: 1, line_end: 1 }),
    ]);
    const outcome = await verify(review);

    expect(outcome.review.findings.map((f) => f.id)).toEqual(["F02", "F03", "F01"]);
    expect(checkReview(outcome.review, { maxFindings: 10 })).toEqual([]);
  });

  it("carries findings the raw file already dropped through untouched", async () => {
    const earlier = {
      id: "F09",
      file: HANDLER,
      line_start: 3,
      line_end: 3,
      summary: "Already dropped",
      reason: "style_only" as const,
    };
    const outcome = await verify(rawReview([finding()], [earlier]));

    expect(outcome.review.dropped).toEqual([earlier]);
    // The stage reports what it removed, which is nothing here.
    expect(outcome.dropped).toEqual([]);
  });

  it("is idempotent: verifying its own output changes nothing", async () => {
    const once = await verify(
      rawReview([finding(), finding({ id: "F02", line_start: 40, line_end: 40 })]),
    );
    const twice = await verify(once.review);
    expect(twice.review).toEqual(once.review);
  });

  it("copies the summary, source and stats from the raw review", async () => {
    const review = rawReview([finding()]);
    const outcome = await verify(review);

    expect(outcome.review.summary).toBe(review.summary);
    expect(outcome.review.source).toEqual(review.source);
    expect(outcome.review.stats).toEqual(review.stats);
  });

  it("produces a valid review when every finding is dropped", async () => {
    const outcome = await verify(rawReview([finding({ evidence: ["invented"] })]));

    expect(outcome.review.findings).toEqual([]);
    expect(validateContract("review", outcome.review).ok).toBe(true);
  });
});

describe("summarizeVerify", () => {
  it("says so when nothing was dropped", async () => {
    expect(summarizeVerify(await verify(rawReview([finding()])))).toBe(
      "1 finding kept, none dropped",
    );
  });

  it("counts the drops by reason", async () => {
    const review = rawReview([
      finding({ id: "F01" }),
      finding({ id: "F02", line_start: 40, line_end: 40 }),
      finding({ id: "F03", line_start: 41, line_end: 41 }),
      finding({ id: "F04", severity: "low", line_start: 20, line_end: 20 }),
    ]);
    expect(summarizeVerify(await verify(review))).toBe(
      "1 finding kept, 3 dropped (2 lines_not_in_diff, 1 duplicate)",
    );
  });
});

describe("run folder", () => {
  it("writes review.json and reads review.raw.json back", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "review.raw.json"),
      JSON.stringify(rawReview([finding()]), null, 2),
      "utf8",
    );

    const outcome = await verify(readRawReview(dir));
    writeVerifiedReview(dir, outcome.review);

    const written: unknown = JSON.parse(readFileSync(path.join(dir, REVIEW_FILE), "utf8"));
    expect(validateContract("review", written).ok).toBe(true);
  });

  it("reports a missing raw review as a verify stage error", () => {
    expect(() => readRawReview(tempDir())).toThrow(StageError);
  });

  it("reports a raw review that breaks its contract", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "review.raw.json"), '{"schema_version":"1.0"}', "utf8");
    expect(() => readRawReview(dir)).toThrow(ContractError);
  });
});

describe("golden set", () => {
  describe("the agent layer", () => {
    /** A second finding that survives the first layer: real lines, verbatim evidence. */
    const second = (over: Partial<Finding> = {}): Finding =>
      finding({
        id: "F02",
        line_start: 22,
        line_end: 22,
        category: "api-contract",
        summary: "The event payload is untyped",
        evidence: ["this.broker.emit('order.placed', {"],
        ...over,
      });

    /** A judge that answers from a table, and records which findings it was shown. */
    function judgeOf(table: Record<string, Verdict>) {
      const seen: string[] = [];
      const judge = (findings: readonly Finding[]) => {
        const verdicts = new Map<string, Verdict>();
        for (const f of findings) {
          seen.push(f.id);
          const verdict = table[f.id];
          if (verdict !== undefined) verdicts.set(f.id, verdict);
        }
        return Promise.resolve({ verdicts, stopped: null, failed: 0 });
      };
      return { judge, seen };
    }

    it("changes nothing at all when no judge is given", async () => {
      // The regression that matters: the stage stays offline, instant and free by default.
      const review = rawReview([finding(), second()]);
      const without = await runVerify({ ingest, review, config: defaultConfig() });

      expect(without.judged).toBe(0);
      expect(without.downgraded).toBe(0);
      expect(without.review.findings.every((f) => f.verification?.status === "verified")).toBe(
        true,
      );
    });

    it("applies a downgrade, recording what the severity was", async () => {
      const { judge } = judgeOf({
        F01: { verdict: "downgrade", severity: "low", note: "A log line, not a breach." },
      });
      const outcome = await runVerify({
        ingest,
        review: rawReview([finding({ severity: "critical" })]),
        config: defaultConfig(),
        judge,
      });

      expect(outcome.judged).toBe(1);
      expect(outcome.downgraded).toBe(1);
      expect(outcome.review.findings[0]?.severity).toBe("low");
      expect(outcome.review.findings[0]?.verification).toEqual({
        status: "downgraded",
        original_severity: "critical",
        note: "A log line, not a breach.",
      });
    });

    it("moves a dropped finding into dropped with the agent's reason", async () => {
      const { judge } = judgeOf({
        F01: { verdict: "drop", reason: "style_only", note: "A preference." },
      });
      const outcome = await runVerify({
        ingest,
        review: rawReview([finding(), second()]),
        config: defaultConfig(),
        judge,
      });

      expect(outcome.review.findings.map((f) => f.id)).toEqual(["F02"]);
      expect(outcome.dropped.map((d) => [d.id, d.reason])).toEqual([["F01", "style_only"]]);
    });

    it("keeps a finding the judge did not answer for", async () => {
      // A budget stop mid-pass leaves later findings unjudged; they keep the first layer's word.
      const outcome = await runVerify({
        ingest,
        review: rawReview([finding(), second()]),
        config: defaultConfig(),
        judge: () =>
          Promise.resolve({
            verdicts: new Map([["F01", { verdict: "keep" as const, note: "True." }]]),
            stopped: "budget:agentSteps",
            failed: 0,
          }),
      });

      expect(outcome.review.findings.map((f) => f.id)).toEqual(["F01", "F02"]);
      expect(outcome.judged).toBe(1);
      expect(outcome.stopped).toBe("budget:agentSteps");
      expect(summarizeVerify(outcome)).toContain("agent stopped: budget:agentSteps");
    });

    it("re-sorts after a downgrade, so the contract's ordering still holds", async () => {
      // A critical dropped to low belongs at the end of the list, not where it was.
      const { judge } = judgeOf({
        F01: { verdict: "downgrade", severity: "low", note: "Overstated." },
      });
      const review = rawReview([
        finding({ id: "F01", severity: "critical", line_start: 12, line_end: 12 }),
        second({ severity: "medium" }),
      ]);
      const outcome = await runVerify({ ingest, review, config: defaultConfig(), judge });

      expect(outcome.review.findings.map((f) => f.id)).toEqual(["F02", "F01"]);
      expect(checkReview(outcome.review, { maxFindings: 10 })).toEqual([]);
    });

    it("shows the judge only what survived the deterministic checks", async () => {
      // Judging a finding the first layer already threw away would waste a call and could
      // resurrect nothing, so the pass must never see one.
      const { judge, seen } = judgeOf({});
      await runVerify({
        ingest,
        review: rawReview([finding(), second({ evidence: ["invented"] })]),
        config: defaultConfig(),
        judge,
      });

      expect(seen).toEqual(["F01"]);
    });

    it("does not re-judge a verdict an earlier run already recorded", async () => {
      // Idempotence: `spr stage verify` twice must not stack downgrades on one finding.
      const { judge } = judgeOf({
        F01: { verdict: "downgrade", severity: "medium", note: "Once." },
      });
      const once = await runVerify({
        ingest,
        review: rawReview([finding({ severity: "high" })]),
        config: defaultConfig(),
        judge,
      });
      const twice = await runVerify({ ingest, review: once.review, config: defaultConfig() });

      expect(twice.review.findings[0]?.severity).toBe("medium");
      expect(twice.review.findings[0]?.verification).toEqual({
        status: "downgraded",
        original_severity: "high",
        note: "Once.",
      });
    });

    it("counts what it could not judge, and says so", async () => {
      const outcome = await runVerify({
        ingest,
        review: rawReview([finding()]),
        config: defaultConfig(),
        judge: () => Promise.resolve({ verdicts: new Map(), stopped: null, failed: 1 }),
      });

      expect(outcome.kept).toBe(1);
      expect(summarizeVerify(outcome)).toContain("1 not judged");
    });
  });

  // Every expected review is what this stage should produce, so nothing in it may be dropped.
  // This is the regression test for the prompt, the renderer and the fixtures together.
  it.each(GOLDEN_SAMPLES)("%s: every expected finding survives verification", async (sample) => {
    const review = readGoldenJson(sample, "review.expected.json") as ReviewResult;
    const outcome = await runVerify({
      ingest: ingestOfDiff(readGoldenDiff(sample)),
      review,
      config: defaultConfig(),
    });

    expect(outcome.dropped).toEqual([]);
    expect(outcome.review.findings.map((f) => f.id)).toEqual(review.findings.map((f) => f.id));
  });
});
