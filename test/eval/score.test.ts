import { describe, expect, it } from "vitest";
import {
  buildReport,
  calibration,
  found,
  locates,
  measureScript,
  scoreReview,
  total,
  totalsByOrigin,
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
    origin: "synthetic",
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

describe("calibration", () => {
  it("is not scored at all when the label has no band", () => {
    // Not a pass: an unbanded label must leave the axis alone rather than flatter it. A
    // RequiredLabel always has a floor, so its band is open exactly when the ceiling is absent;
    // an AcceptableLabel can be missing either end.
    expect(calibration(finding(), required())).toBeNull();
    expect(
      calibration(finding(), {
        key: "half-banded",
        file: FILE,
        line_start: 19,
        line_end: 27,
        category: "event-consistency",
        max_severity: "high",
        description: "Only a ceiling.",
      }),
    ).toBeNull();
  });

  it.each([
    ["critical", "over"],
    ["high", "in"],
    ["medium", "in"],
    ["low", "under"],
  ] as const)("puts a %s finding %s a high..medium band", (severity, verdict) => {
    const label = required({ max_severity: "high", min_severity: "medium" });
    expect(calibration(finding({ severity }), label)).toBe(verdict);
  });

  it("accepts only one severity when the band is a single level", () => {
    const label = required({ max_severity: "high", min_severity: "high" });
    expect(calibration(finding({ severity: "high" }), label)).toBe("in");
    expect(calibration(finding({ severity: "critical" }), label)).toBe("over");
    expect(calibration(finding({ severity: "medium" }), label)).toBe("under");
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

describe("scoreReview and calibration", () => {
  it("reports the band a matched finding missed, and which way", () => {
    // sample-03's real shape: a low privacy issue rated critical, which scored 1.000/1.000
    // on precision and recall before this axis existed (ADR-036).
    const label = required({ max_severity: "medium", min_severity: "low" });
    const score = scoreReview(
      review([finding({ severity: "critical" })]),
      labels({ must_find: [label] }),
    );

    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.calibrated).toBe(0);
    expect(score.calibration_scored).toBe(1);
    expect(score.miscalibrated).toEqual([
      {
        key: "publish-before-commit",
        finding_id: "F01",
        severity: "critical",
        max_severity: "medium",
        min_severity: "low",
        direction: "over",
      },
    ]);
  });

  it("leaves calibration null when no matched label carries a band", () => {
    // The state the golden set was in before this step: nothing to say, so it says nothing.
    const score = scoreReview(review([finding()]), labels());
    expect(score.precision).toBe(1);
    expect(score.calibrated).toBeNull();
    expect(score.calibration_scored).toBe(0);
    expect(score.miscalibrated).toEqual([]);
  });

  it("never counts an under-rated must_find twice", () => {
    // `found` already rejects it on severity, so it is a recall gap and not also a calibration
    // one - which is exactly the asymmetry ADR-025 chose and this axis must not disturb.
    const label = required({ min_severity: "high", max_severity: "high" });
    const score = scoreReview(
      review([finding({ severity: "low" })]),
      labels({ must_find: [label] }),
    );

    expect(score.recall).toBe(0);
    expect(score.missed).toEqual(["publish-before-commit"]);
    expect(score.calibration_scored).toBe(0);
    expect(score.miscalibrated).toEqual([]);
  });

  it("scores an acceptable label's band at both ends", () => {
    // `locates` ignores severity, so an optional finding can be under-rated as well as over.
    const score = scoreReview(
      review([finding({ severity: "low" })]),
      labels({
        must_find: [],
        acceptable: [
          {
            key: "untyped-event-contract",
            file: FILE,
            line_start: 19,
            line_end: 27,
            category: "event-consistency",
            min_severity: "medium",
            max_severity: "high",
            description: "Optional.",
          },
        ],
      }),
    );

    expect(score.calibrated).toBe(0);
    expect(score.miscalibrated?.[0]?.direction).toBe("under");
  });
});

describe("total", () => {
  function sample(over: Partial<SampleResult["review"]>, seconds = 1): SampleResult {
    return {
      sample: "s",
      origin: "synthetic",
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

  it("counts narration only over samples that had something to narrate", () => {
    const made = { ...sample({ kept: 1 }), script: { narrated: true } };
    const failed = { ...sample({ kept: 2 }), script: { narrated: false, failure: "71 words" } };
    const clean = { ...sample({ kept: 0 }), script: { narrated: null, failure: null } };

    const t = total([made, failed, clean, clean]);
    // The failure counts against the total; the two clean samples are in neither number.
    expect(t.narrated).toBe(1);
    expect(t.narratable).toBe(2);
  });

  it("has nothing narratable when every sample kept nothing", () => {
    const clean = { ...sample({ kept: 0 }), script: { narrated: null, failure: null } };
    const t = total([clean, clean]);
    expect(t.narrated).toBe(0);
    expect(t.narratable).toBe(0);
  });
});

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe("total and calibration", () => {
  const sample = (over: Partial<SampleResult["review"]>): SampleResult =>
    ({
      sample: "s",
      review: {
        kept: 1,
        within_budget: true,
        precision: 1,
        recall: 1,
        found: [],
        missed: [],
        acceptable_found: [],
        false_positives: [],
        dropped: [],
        ...over,
      },
      script: { narrated: true },
    }) as SampleResult;

  it("adds up over findings, not over samples", () => {
    // One sample with three banded findings should outweigh one with a single banded finding,
    // which averaging the per-sample rates would not do.
    const t = total([
      sample({ calibrated: 1, calibration_scored: 3, miscalibrated: [] }),
      sample({ calibrated: 0, calibration_scored: 1, miscalibrated: [{}] as never }),
    ]);
    expect(t.calibrated).toBe(0.75);
    expect(t.miscalibrated).toBe(1);
  });

  it("stays null when no sample had a band to score", () => {
    const t = total([sample({ calibrated: null }), sample({ calibrated: null })]);
    expect(t.calibrated).toBeNull();
    expect(t.miscalibrated).toBe(0);
  });
});

describe("measureScript", () => {
  it("measures what the checks do not constrain", () => {
    const { review: verified, script } = loadGolden("sample-01-order-outbox");
    const result = measureScript(verified, script, script);

    expect(result.narrated).toBe(true);
    // One step per finding, no intro or wrap-up (ADR-042).
    expect(result.steps).toBe(3);
    expect(result.max_step_words).toBe(60);
    expect(result.expected_steps).toBe(3);
  });

  it("records a failed Narrate stage as a result rather than losing the sample", () => {
    const result = measureScript(
      review([finding()]),
      undefined,
      undefined,
      "71 words, maximum is 60",
    );
    expect(result.narrated).toBe(false);
    expect(result.failure).toContain("71 words");
    expect(result.steps).toBeUndefined();
  });

  it("says a review that kept nothing had nothing to narrate, rather than that it failed", () => {
    // sample-07's shape: a restraint sample where keeping nothing is a good result (ADR-042).
    const { script: expected } = loadGolden("sample-07-retry-backoff");
    const result = measureScript(review([]), undefined, expected);
    expect(result).toEqual({ narrated: null, failure: null });
  });

  it("decides nothing to narrate from the review, whatever failure arrived with it", () => {
    const result = measureScript(review([]), undefined, undefined, "This review kept no findings");
    expect(result.narrated).toBeNull();
    expect(result.failure).toBeNull();
  });
});

describe("redundancy (step 7)", () => {
  it("counts two findings on one label as saying it twice - ADR-029's own case", () => {
    const first = finding({ id: "F01", category: "ddd-boundaries", line_start: 19, line_end: 19 });
    const second = finding({ id: "F02", category: "ddd-boundaries", line_start: 20, line_end: 20 });
    const score = scoreReview(
      review([first, second]),
      labels({
        must_find: [
          required({
            key: "application-depends-on-orm",
            category: "ddd-boundaries",
            min_severity: "medium",
          }),
        ],
      }),
    );
    // Precision and recall cannot see it - exactly why it is its own axis.
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.redundant).toEqual([
      { key: "application-depends-on-orm", finding_ids: ["F01", "F02"] },
    ]);
  });

  it("does not call one finding that locates two labels redundant", () => {
    const broad = finding({ line_start: 19, line_end: 27 });
    const score = scoreReview(
      review([broad]),
      labels({
        acceptable: [
          {
            key: "also-here",
            file: FILE,
            line_start: 22,
            line_end: 26,
            category: "event-consistency",
            description: "A second issue on the same lines.",
          },
        ],
      }),
    );
    expect(score.redundant).toEqual([]);
  });

  it("totals the surplus, not the labels: three on one label is two too many", () => {
    const base = {
      sample: "s",
      origin: "synthetic" as const,
      run_dir: "/tmp/s",
      cached: false,
      review: {
        kept: 3,
        max_findings: null,
        within_budget: true,
        precision: 1,
        recall: 1,
        found: [],
        missed: [],
        acceptable_found: [],
        false_positives: [],
        dropped: [],
        redundant: [{ key: "k", finding_ids: ["F01", "F02", "F03"] }],
      },
      script: { narrated: true },
    };
    expect(total([base]).redundant).toBe(2);
  });
});

describe("near misses", () => {
  it("names the label a false positive sits on under another category, and keeps it false", () => {
    // sample-05's shape: the redelivery bug described correctly, filed as event-consistency.
    const misfiled = finding({ category: "event-consistency", line_start: 22, line_end: 22 });
    const score = scoreReview(
      review([misfiled]),
      labels({ must_find: [required({ key: "replay-double-counts", category: "idempotency" })] }),
    );

    expect(score.precision).toBe(0);
    expect(score.missed).toEqual(["replay-double-counts"]);
    expect(score.false_positives[0]?.near_miss_key).toBe("replay-double-counts");
  });

  it("prefers a must_find label to an acceptable one on the same lines", () => {
    const misfiled = finding({ category: "performance" });
    const score = scoreReview(
      review([misfiled]),
      labels({
        acceptable: [
          {
            key: "optional-here-too",
            file: FILE,
            line_start: 19,
            line_end: 27,
            category: "api-contract",
            description: "Also on these lines.",
          },
        ],
      }),
    );
    expect(score.false_positives[0]?.near_miss_key).toBe("publish-before-commit");
  });

  it("leaves a mistake the set already names as that name, not as a near miss", () => {
    // sample-05 again: the false DROP COLUMN claim sits on a must_find's lines too.
    const wrong = finding({ category: "maintainability" });
    const score = scoreReview(
      review([wrong]),
      labels({
        must_not_flag: [
          {
            key: "known-wrong-claim",
            file: FILE,
            line_start: 19,
            line_end: 27,
            description: "A claim this sample is known to attract.",
          },
        ],
      }),
    );
    expect(score.false_positives[0]?.must_not_flag_key).toBe("known-wrong-claim");
    expect(score.false_positives[0]?.near_miss_key).toBeNull();
  });

  it("is null when nothing is at that place", () => {
    const elsewhere = finding({ line_start: 90, line_end: 91 });
    expect(scoreReview(review([elsewhere]), labels()).false_positives[0]?.near_miss_key).toBeNull();
  });
});

describe("totalsByOrigin", () => {
  function sample(origin: SampleResult["origin"], over: Partial<SampleResult["review"]>) {
    return {
      sample: `s-${origin}`,
      origin,
      run_dir: "/tmp/s",
      cached: false,
      seconds: 1,
      review: {
        kept: 1,
        max_findings: null,
        within_budget: true,
        precision: 1,
        recall: 1,
        found: [],
        missed: [],
        acceptable_found: [],
        false_positives: [],
        dropped: [],
        ...over,
      },
      script: { narrated: true },
    } satisfies SampleResult;
  }

  it("scores each origin on its own items rather than on the pooled ones", () => {
    const real = sample("real", { kept: 2, found: [{ key: "a", finding_id: "F01" }], missed: [] });
    const synthetic = sample("synthetic", {
      kept: 2,
      found: [{ key: "b", finding_id: "F01" }],
      missed: ["c"],
    });

    const entries = totalsByOrigin([real, synthetic]);
    expect(entries.map((e) => e.origin)).toEqual(["real", "synthetic"]);
    expect(entries[0]?.recall).toBe(1);
    expect(entries[0]?.must_find).toBe(1);
    // Pooled recall is 2/3, which is the number this axis exists to stop anyone quoting as
    // evidence about real code.
    expect(entries[1]?.recall).toBe(0.5);
    expect(total([real, synthetic]).recall).toBe(rounded(2 / 3));
  });

  it("gives an origin the set does not contain no entry at all", () => {
    const entries = totalsByOrigin([sample("synthetic", {})]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.origin).toBe("synthetic");
    expect(entries[0]?.samples).toBe(1);
  });

  it("produces entries the contract accepts", () => {
    const report = buildReport("golden", [
      {
        provider: "ollama",
        model: "qwen3:30b",
        samples: [sample("real", {}), sample("synthetic", {})],
        totals: total([sample("real", {}), sample("synthetic", {})]),
        by_origin: totalsByOrigin([sample("real", {}), sample("synthetic", {})]),
      },
    ]);
    const result = validateContract("eval", report);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe("buildReport", () => {
  it("accepts a sample with nothing to narrate under the contract", () => {
    const clean: SampleResult = {
      sample: "sample-07-retry-backoff",
      origin: "synthetic",
      run_dir: "/tmp/s",
      cached: false,
      seconds: 1,
      stopped: null,
      review: scoreReview(review([]), labels({ must_find: [] })),
      script: measureScript(review([]), undefined, undefined),
    };
    const report = buildReport("golden", [
      { provider: "fake", model: "fake", samples: [clean], totals: total([clean]) },
    ]);
    const result = validateContract("eval", report);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

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
