import { describe, expect, it } from "vitest";
import {
  buildReport,
  found,
  locates,
  measureScript,
  scoreReview,
  total,
} from "../../src/eval/score.js";
import { readLabels } from "../../src/eval/run.js";
import type { SampleResult } from "../../src/contracts/generated/eval.js";
import type { GoldenLabels, RequiredLabel } from "../../src/contracts/generated/labels.js";
import type { Finding, ReviewResult } from "../../src/contracts/generated/review.js";
import { validateContract } from "../../src/contracts/validate.js";
import { GOLDEN_DIR, GOLDEN_SAMPLES, loadGolden, TEST_SOURCE } from "../helpers.js";

const FILE = "services/order-service/src/application/commands/place-order.handler.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F01",
    file: FILE,
    side: "new",
    line_start: 19,
    line_end: 27,
    severity: "high",
    category: "event-consistency",
    summary: "The event is published inside the transaction",
    rationale: "If the commit fails, other services hear about an order that was not saved.",
    suggestion: "Use a transactional outbox.",
    confidence: 0.9,
    evidence: ["this.events.emit('order.placed', {"],
    verification: { status: "verified" },
    ...over,
  };
}

function required(over: Partial<RequiredLabel> = {}): RequiredLabel {
  return {
    key: "publish-before-commit",
    file: FILE,
    line_start: 19,
    line_end: 27,
    category: "event-consistency",
    min_severity: "high",
    description: "Event emitted inside the transaction.",
    ...over,
  };
}

function labels(over: Partial<GoldenLabels> = {}): GoldenLabels {
  return {
    sample: "sample-test",
    must_find: [required()],
    acceptable: [],
    must_not_flag: [],
    ...over,
  };
}

function review(findings: Finding[], dropped: ReviewResult["dropped"] = []): ReviewResult {
  return {
    schema_version: "1.0",
    source: { ...TEST_SOURCE },
    summary: "A change.",
    findings,
    dropped,
    stats: { files_reviewed: 1, files_skipped: [] },
  };
}

describe("locates", () => {
  it("matches the same file, overlapping lines and the label's category", () => {
    expect(locates(finding(), required())).toBe(true);
  });

  it("accepts a range that merely overlaps, at either edge", () => {
    expect(locates(finding({ line_start: 27, line_end: 40 }), required())).toBe(true);
    expect(locates(finding({ line_start: 1, line_end: 19 }), required())).toBe(true);
  });

  it("rejects the right file with lines that do not overlap", () => {
    expect(locates(finding({ line_start: 28, line_end: 30 }), required())).toBe(false);
  });

  it("rejects another file at the same lines", () => {
    expect(locates(finding({ file: "services/other/src/thing.ts" }), required())).toBe(false);
  });

  it("rejects overlapping lines under a category the label does not accept", () => {
    expect(locates(finding({ category: "performance" }), required())).toBe(false);
  });

  it("accepts a category listed in accept_categories", () => {
    const label = required({ accept_categories: ["correctness", "error-handling"] });
    expect(locates(finding({ category: "error-handling" }), label)).toBe(true);
  });
});

describe("found", () => {
  it("needs severity at least as serious as the label demands", () => {
    expect(found(finding({ severity: "critical" }), required())).toBe(true);
    expect(found(finding({ severity: "high" }), required())).toBe(true);
    expect(found(finding({ severity: "medium" }), required())).toBe(false);
  });

  it("treats an under-rated finding as precise but not as found (ADR-015, ADR-018)", () => {
    const soft = finding({ severity: "medium" });
    // It points at the right code with the right category, so nothing spurious was said.
    expect(locates(soft, required())).toBe(true);
    const score = scoreReview(review([soft]), labels());
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(0);
    expect(score.missed).toEqual(["publish-before-commit"]);
    expect(score.false_positives).toEqual([]);
  });
});

describe("scoreReview", () => {
  it("scores a finding that matches its label", () => {
    const score = scoreReview(review([finding()]), labels());
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.found).toEqual([
      { key: "publish-before-commit", finding_id: "F01", severity: "high" },
    ]);
  });

  it("counts an acceptable match as precise without counting it toward recall", () => {
    const extra = finding({ id: "F02", category: "api-contract", line_start: 22, line_end: 26 });
    const score = scoreReview(
      review([finding(), extra]),
      labels({
        acceptable: [
          {
            key: "untyped-event-contract",
            file: FILE,
            line_start: 22,
            line_end: 26,
            category: "api-contract",
            description: "Inline event payload.",
          },
        ],
      }),
    );
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.found).toHaveLength(1);
  });

  it("records an optional issue that was spotted, which no rate can show", () => {
    const acceptable = {
      key: "pii-in-error",
      file: FILE,
      line_start: 11,
      line_end: 11,
      category: "privacy" as const,
      description: "Raw address in the error message.",
    };
    const spotted = finding({ line_start: 11, line_end: 11, category: "privacy" });

    const said = scoreReview(
      review([spotted]),
      labels({ must_find: [], acceptable: [acceptable] }),
    );
    const silent = scoreReview(review([]), labels({ must_find: [], acceptable: [acceptable] }));

    // Neither run is penalised, and neither gains recall: the difference is only visible here.
    expect(said.acceptable_found.map((m) => m.key)).toEqual(["pii-in-error"]);
    expect(said.false_positives).toEqual([]);
    expect(silent.acceptable_found).toEqual([]);
    expect(silent.recall).toBe(said.recall);
  });

  it("reports recall as undefined, not zero, when the sample has no must_find labels", () => {
    const score = scoreReview(review([]), labels({ must_find: [] }));
    expect(score.recall).toBeNull();
  });

  it("reports precision as undefined when nothing was kept", () => {
    const score = scoreReview(review([]), labels({ must_find: [] }));
    expect(score.precision).toBeNull();
    expect(score.kept).toBe(0);
  });

  it("names a false positive after the must_not_flag label it matches", () => {
    const stray = finding({
      id: "F02",
      file: FILE,
      line_start: 1,
      line_end: 3,
      category: "testing",
    });
    const score = scoreReview(
      review([stray]),
      labels({
        must_find: [],
        must_not_flag: [{ key: "import-order", file: FILE, description: "Import ordering." }],
      }),
    );
    expect(score.false_positives).toHaveLength(1);
    expect(score.false_positives[0]?.must_not_flag_key).toBe("import-order");
    expect(score.precision).toBe(0);
  });

  it("leaves a false positive unnamed when no label describes it", () => {
    const stray = finding({ id: "F02", file: "services/other/src/thing.ts" });
    const score = scoreReview(review([stray]), labels({ must_find: [] }));
    expect(score.false_positives[0]?.must_not_flag_key).toBeNull();
  });

  it("never counts a dropped finding as a false positive, but counts why it went", () => {
    const score = scoreReview(
      review(
        [finding()],
        [
          { id: "F02", file: FILE, summary: "x", reason: "claim_not_supported" },
          { id: "F03", file: FILE, summary: "y", reason: "claim_not_supported" },
          { id: "F04", file: FILE, summary: "z", reason: "duplicate" },
        ],
      ),
      labels(),
    );
    expect(score.precision).toBe(1);
    expect(score.false_positives).toEqual([]);
    expect(score.dropped).toEqual([
      { reason: "claim_not_supported", count: 2 },
      { reason: "duplicate", count: 1 },
    ]);
  });

  it("scores restraint separately from precision", () => {
    const two = [finding(), finding({ id: "F02", line_start: 20, line_end: 21 })];
    const strict = scoreReview(review(two), labels({ max_findings: 1 }));
    expect(strict.precision).toBe(1);
    expect(strict.within_budget).toBe(false);
    expect(strict.max_findings).toBe(1);

    expect(scoreReview(review(two), labels()).within_budget).toBe(true);
  });
});

describe("total", () => {
  function sample(over: Partial<SampleResult["review"]>, seconds = 1): SampleResult {
    return {
      sample: "s",
      run_dir: "/tmp/s",
      cached: false,
      seconds,
      review: {
        kept: 0,
        max_findings: null,
        within_budget: true,
        precision: null,
        recall: null,
        found: [],
        missed: [],
        acceptable_found: [],
        false_positives: [],
        dropped: [],
        ...over,
      },
      script: { narrated: true },
    };
  }

  it("micro-averages by item, so a small sample does not weigh as much as a large one", () => {
    const big = sample({
      kept: 4,
      found: [{ key: "a", finding_id: "F01" }],
      missed: ["b", "c"],
      false_positives: [],
    });
    const small = sample({
      kept: 1,
      found: [],
      missed: [],
      false_positives: [
        {
          finding_id: "F01",
          file: FILE,
          line_start: 1,
          line_end: 1,
          category: "testing",
          summary: "x",
          must_not_flag_key: null,
        },
      ],
    });

    const t = total([big, small]);
    // 5 kept, 1 false positive -> 0.8. Averaging the two rates (1.0 and 0.0) would say 0.5.
    expect(t.precision).toBe(0.8);
    expect(t.recall).toBe(rounded(1 / 3));
    expect(t.must_find).toBe(3);
    expect(t.kept).toBe(5);
  });

  it("leaves a sample with no must_find labels out of the recall denominator", () => {
    const scored = sample({ kept: 2, found: [{ key: "a", finding_id: "F01" }], missed: [] });
    const restraint = sample({ kept: 0 });
    expect(total([scored, restraint]).recall).toBe(1);
    expect(total([scored, restraint]).must_find).toBe(1);
  });

  it("counts samples that broke their restraint budget", () => {
    const over = sample({ kept: 3, within_budget: false, max_findings: 1 });
    expect(total([over, sample({})]).over_budget).toBe(1);
  });
});

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe("measureScript", () => {
  it("measures what the checks do not constrain", () => {
    const { script } = loadGolden("sample-01-order-outbox");
    const result = measureScript(script, script);

    expect(result.narrated).toBe(true);
    expect(result.steps).toBe(5);
    expect(result.max_step_words).toBe(60);
    expect(result.expected_steps).toBe(5);
  });

  it("records a failed Narrate stage as a result rather than losing the sample", () => {
    const result = measureScript(undefined, undefined, "71 words, maximum is 60");
    expect(result.narrated).toBe(false);
    expect(result.failure).toContain("71 words");
    expect(result.steps).toBeUndefined();
  });
});

describe("buildReport", () => {
  it("produces a report that validates against the contract", () => {
    const report = buildReport(
      "golden",
      [{ provider: "ollama", model: "qwen3:30b", samples: [], totals: total([]) }],
      new Date("2026-09-16T12:00:00Z"),
    );
    expect(report.generated_at).toBe("2026-09-16T12:00:00.000Z");
    const result = validateContract("eval", report);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe("golden set", () => {
  it.each(GOLDEN_SAMPLES)("%s: labels validate and name their own folder", (sample) => {
    expect(readLabels(GOLDEN_DIR, sample).sample).toBe(sample);
  });

  // If this fails, either an expected review or its labels drifted apart.
  it.each(GOLDEN_SAMPLES)(
    "%s: the expected review scores perfectly against its labels",
    (sample) => {
      const { review: expected } = loadGolden(sample);
      const score = scoreReview(expected, readLabels(GOLDEN_DIR, sample));

      expect(score.false_positives).toEqual([]);
      expect(score.missed).toEqual([]);
      expect(score.precision).toBe(1);
      expect(score.recall === null || score.recall === 1).toBe(true);
      expect(score.within_budget).toBe(true);
    },
  );
});
