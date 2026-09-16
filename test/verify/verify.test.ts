import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkReview } from "../../src/contracts/checks.js";
import type { SprConfig } from "../../src/contracts/generated/config.js";
import type { Finding, ReviewResult } from "../../src/contracts/generated/review.js";
import { validateContract } from "../../src/contracts/validate.js";
import { ContractError, StageError } from "../../src/lib/errors.js";
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

function verify(review: ReviewResult, config: SprConfig = defaultConfig()) {
  return runVerify({ ingest, review, config });
}

describe("runVerify", () => {
  it("keeps the ids the Reviewer assigned, gaps and all", () => {
    const review = rawReview([
      finding({ id: "F01", line_start: 40, line_end: 40 }),
      finding({ id: "F02" }),
    ]);
    const outcome = verify(review);

    expect(outcome.review.findings.map((f) => f.id)).toEqual(["F02"]);
    expect(outcome.review.dropped.map((d) => d.id)).toEqual(["F01"]);
  });

  it("marks a finding that passed the checks as verified", () => {
    const outcome = verify(rawReview([finding()]));
    expect(outcome.review.findings[0]?.verification).toEqual({ status: "verified" });
  });

  it("leaves a verdict that is already on the finding alone", () => {
    const downgraded = finding({
      severity: "medium",
      verification: { status: "downgraded", original_severity: "high", note: "rollback only" },
    });
    const outcome = verify(rawReview([downgraded]));
    expect(outcome.review.findings[0]?.verification).toEqual(downgraded.verification);
  });

  it("records the reason and a usable note for each dropped finding", () => {
    const review = rawReview([
      finding({ id: "F01", file: "services/order-service/src/main.ts" }),
      finding({ id: "F02", line_start: 40, line_end: 41 }),
      finding({ id: "F03", evidence: ["this line is invented"] }),
      finding({ id: "F04", line_start: 19, line_end: 27 }),
      finding({ id: "F05", line_start: 20, line_end: 22, severity: "low" }),
    ]);
    const outcome = verify(review);

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

  it("drops what does not fit the cap, lowest severity first", () => {
    const review = rawReview([
      finding({ id: "F01", severity: "low", line_start: 1, line_end: 1 }),
      finding({ id: "F02", severity: "critical", line_start: 3, line_end: 3 }),
      finding({ id: "F03", severity: "medium", line_start: 5, line_end: 5 }),
    ]);
    const outcome = verify(review, configWithCap(2));

    expect(outcome.review.findings.map((f) => f.id)).toEqual(["F02", "F03"]);
    expect(outcome.review.dropped).toEqual([
      expect.objectContaining({ id: "F01", reason: "over_cap" }),
    ]);
  });

  it("orders the kept findings by severity, then file and line", () => {
    const review = rawReview([
      finding({ id: "F01", severity: "low", line_start: 22, line_end: 22 }),
      finding({ id: "F02", severity: "critical", line_start: 12, line_end: 12 }),
      finding({ id: "F03", severity: "low", line_start: 1, line_end: 1 }),
    ]);
    const outcome = verify(review);

    expect(outcome.review.findings.map((f) => f.id)).toEqual(["F02", "F03", "F01"]);
    expect(checkReview(outcome.review, { maxFindings: 10 })).toEqual([]);
  });

  it("carries findings the raw file already dropped through untouched", () => {
    const earlier = {
      id: "F09",
      file: HANDLER,
      line_start: 3,
      line_end: 3,
      summary: "Already dropped",
      reason: "style_only" as const,
    };
    const outcome = verify(rawReview([finding()], [earlier]));

    expect(outcome.review.dropped).toEqual([earlier]);
    // The stage reports what it removed, which is nothing here.
    expect(outcome.dropped).toEqual([]);
  });

  it("is idempotent: verifying its own output changes nothing", () => {
    const once = verify(
      rawReview([finding(), finding({ id: "F02", line_start: 40, line_end: 40 })]),
    );
    const twice = verify(once.review);
    expect(twice.review).toEqual(once.review);
  });

  it("copies the summary, source and stats from the raw review", () => {
    const review = rawReview([finding()]);
    const outcome = verify(review);

    expect(outcome.review.summary).toBe(review.summary);
    expect(outcome.review.source).toEqual(review.source);
    expect(outcome.review.stats).toEqual(review.stats);
  });

  it("produces a valid review when every finding is dropped", () => {
    const outcome = verify(rawReview([finding({ evidence: ["invented"] })]));

    expect(outcome.review.findings).toEqual([]);
    expect(validateContract("review", outcome.review).ok).toBe(true);
  });
});

describe("summarizeVerify", () => {
  it("says so when nothing was dropped", () => {
    expect(summarizeVerify(verify(rawReview([finding()])))).toBe("1 finding kept, none dropped");
  });

  it("counts the drops by reason", () => {
    const review = rawReview([
      finding({ id: "F01" }),
      finding({ id: "F02", line_start: 40, line_end: 40 }),
      finding({ id: "F03", line_start: 41, line_end: 41 }),
      finding({ id: "F04", severity: "low", line_start: 20, line_end: 20 }),
    ]);
    expect(summarizeVerify(verify(review))).toBe(
      "1 finding kept, 3 dropped (2 lines_not_in_diff, 1 duplicate)",
    );
  });
});

describe("run folder", () => {
  it("writes review.json and reads review.raw.json back", () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "review.raw.json"),
      JSON.stringify(rawReview([finding()]), null, 2),
      "utf8",
    );

    const outcome = verify(readRawReview(dir));
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
  // Every expected review is what this stage should produce, so nothing in it may be dropped.
  // This is the regression test for the prompt, the renderer and the fixtures together.
  it.each(GOLDEN_SAMPLES)("%s: every expected finding survives verification", (sample) => {
    const review = readGoldenJson(sample, "review.expected.json") as ReviewResult;
    const outcome = runVerify({
      ingest: ingestOfDiff(readGoldenDiff(sample)),
      review,
      config: defaultConfig(),
    });

    expect(outcome.dropped).toEqual([]);
    expect(outcome.review.findings.map((f) => f.id)).toEqual(review.findings.map((f) => f.id));
  });
});
