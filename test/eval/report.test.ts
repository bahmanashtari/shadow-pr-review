import { describe, expect, it } from "vitest";
import { formatComparison, formatModel, formatReport } from "../../src/eval/report.js";
import type { ModelRun, SampleResult } from "../../src/contracts/generated/eval.js";
import { buildReport, total, totalsByOrigin } from "../../src/eval/score.js";

const FILE = "services/order-service/src/application/commands/place-order.handler.ts";

function sample(over: Partial<SampleResult> = {}): SampleResult {
  return {
    sample: "sample-01-order-outbox",
    origin: "synthetic",
    run_dir: "/tmp/runs/eval/sample-01",
    cached: false,
    seconds: 23,
    stopped: null,
    review: {
      kept: 3,
      max_findings: null,
      within_budget: true,
      precision: 1,
      recall: 1,
      found: [{ key: "publish-before-commit", finding_id: "F01", severity: "high" }],
      missed: [],
      acceptable_found: [],
      false_positives: [],
      dropped: [],
    },
    script: { narrated: true, steps: 5, estimated_seconds: 51, expected_steps: 5 },
    ...over,
  };
}

function run(over: Partial<ModelRun> = {}): ModelRun {
  const samples = over.samples ?? [sample()];
  return {
    provider: "ollama",
    model: "qwen3:30b",
    samples,
    totals: total(samples),
    ...over,
  };
}

describe("formatModel", () => {
  it("prints a row per sample and a total", () => {
    const lines = formatModel(run());
    expect(lines[0]).toBe("ollama / qwen3:30b");
    expect(lines[1]).toContain("sample");
    expect(lines[2]).toContain("sample-01-order-outbox");
    expect(lines[2]).toContain("1.000");
    expect(lines[3]).toContain("TOTAL");
    expect(lines[3]).toContain("1/1 must_find");
  });

  it("prints an undefined rate as a dash rather than as zero", () => {
    const restraint = sample({
      review: { ...sample().review, kept: 0, precision: null, recall: null, found: [] },
    });
    expect(formatModel(run({ samples: [restraint] }))[2]).toMatch(/\s-\s+-\s/);
  });

  it("spells out what went wrong, which is the part worth acting on", () => {
    const bad = sample({
      review: {
        ...sample().review,
        kept: 2,
        precision: 0.5,
        recall: 0,
        found: [],
        missed: ["publish-before-commit"],
        max_findings: 1,
        within_budget: false,
        false_positives: [
          {
            finding_id: "F02",
            file: FILE,
            line_start: 1,
            line_end: 3,
            category: "maintainability",
            summary: "Imports are not grouped",
            must_not_flag_key: "import-order",
          },
        ],
        dropped: [{ reason: "claim_not_supported", count: 2 }],
      },
    });
    const text = formatModel(run({ samples: [bad] })).join("\n");

    expect(text).toContain("2 claim_not_supported");
    expect(text).toContain("missed: publish-before-commit");
    expect(text).toContain("over budget: kept 2, allowed 1");
    expect(text).toContain("false positive F02 (import-order)");
    expect(text).toContain("Imports are not grouped");
  });

  it("says when a sample never reached a script", () => {
    const failed = sample({
      script: { narrated: false, failure: "/steps/2 (S02): 71 words, maximum is 60" },
    });
    const text = formatModel(run({ samples: [failed] })).join("\n");
    expect(text).toContain("not narrated");
    expect(text).toContain("narrate failed: /steps/2 (S02): 71 words");
  });

  it("names an unlabelled false positive as such", () => {
    const novel = sample({
      review: {
        ...sample().review,
        false_positives: [
          {
            finding_id: "F03",
            file: FILE,
            line_start: 9,
            line_end: 9,
            category: "performance",
            summary: "Something new",
            must_not_flag_key: null,
          },
        ],
      },
    });
    expect(formatModel(run({ samples: [novel] })).join("\n")).toContain("(unlabelled)");
  });

  it("says where a false positive landed when it sits on a label under another category", () => {
    const misfiled = sample({
      review: {
        ...sample().review,
        false_positives: [
          {
            finding_id: "F02",
            file: FILE,
            line_start: 13,
            line_end: 13,
            category: "event-consistency",
            summary: "Event handler lacks idempotency",
            must_not_flag_key: null,
            near_miss_key: "projection-double-counts-on-replay",
          },
        ],
      },
    });
    const text = formatModel(run({ samples: [misfiled] })).join("\n");
    expect(text).toContain("false positive F02 (unlabelled) event-consistency");
    expect(text).toContain(
      "on projection-double-counts-on-replay's lines, filed under event-consistency",
    );
  });
});

describe("the origin of the samples", () => {
  function run(samples: SampleResult[]): ModelRun {
    return {
      provider: "ollama",
      model: "qwen3:30b",
      samples,
      totals: total(samples),
      by_origin: totalsByOrigin(samples),
    };
  }

  it("says in words when every sample is synthetic, rather than repeating the total", () => {
    const lines = formatModel(run([sample(), sample({ sample: "sample-02" })])).join("\n");
    expect(lines).toContain("all 2 samples are synthetic");
    expect(lines).toContain("written for it to find");
    expect(lines).not.toMatch(/^ {2}synthetic\s+\d/m);
  });

  it("splits the total into a row per origin once the set holds both", () => {
    const lines = formatModel(
      run([sample(), sample({ sample: "sample-04", origin: "real" })]),
    ).join("\n");
    expect(lines).toMatch(/^ {2}real\s/m);
    expect(lines).toMatch(/^ {2}synthetic\s/m);
    expect(lines).toContain("1 sample, 1/1 must_find");
  });
});

describe("an incomplete model", () => {
  it("is labelled in its own block and marked in the comparison", () => {
    const broken = run({ model: "mistral-small3.2", failed: "sample-02: /summary: too long" });

    expect(formatModel(broken)[0]).toContain("INCOMPLETE - sample-02");

    const table = formatComparison([run(), broken]).join("\n");
    expect(table).toContain("mistral-small3.2 *");
    expect(table).toContain("not comparable");
  });
});

describe("formatComparison", () => {
  it("puts one row per model side by side", () => {
    const lines = formatComparison([run(), run({ model: "qwen3:4b" })]);
    expect(lines[0]).toContain("model");
    expect(lines[1]).toContain("qwen3:30b");
    expect(lines[2]).toContain("qwen3:4b");
  });
});

describe("formatReport", () => {
  it("adds the comparison only when more than one model was scored", () => {
    const one = formatReport(buildReport("golden", [run()]));
    expect(one.join("\n")).not.toContain("comparison");

    const two = formatReport(buildReport("golden", [run(), run({ model: "qwen3:4b" })]));
    expect(two.join("\n")).toContain("comparison");
  });
});
