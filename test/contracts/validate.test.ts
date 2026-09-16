import { describe, expect, it } from "vitest";
import { contractFromFileName, CONTRACT_NAMES, loadSchema } from "../../src/contracts/schemas.js";
import { assertContract, validateContract } from "../../src/contracts/validate.js";
import { ContractError } from "../../src/lib/errors.js";
import { loadGolden } from "../helpers.js";

describe("schemas", () => {
  it.each(CONTRACT_NAMES)("%s schema compiles and has a title", (name) => {
    expect(loadSchema(name).title).toEqual(expect.any(String));
    // Compiling happens on first use; an empty object must fail, not throw.
    expect(validateContract(name, {}).ok).toBe(false);
  });

  it("defines Source identically in the ingest and review schemas", () => {
    // The Reviewer copies `source` straight from ingest.json into review.json.
    const defsOf = (name: "ingest" | "review"): unknown =>
      (loadSchema(name).$defs as Record<string, unknown>).Source;
    expect(defsOf("ingest")).toEqual(defsOf("review"));
  });
});

describe("validateContract", () => {
  it("reports readable errors with paths and allowed values", () => {
    const { review } = loadGolden("sample-01-order-outbox");
    const bad = structuredClone(review) as unknown as {
      findings: Record<string, unknown>[];
      extra?: unknown;
    };
    bad.findings[0] = { ...bad.findings[0], severity: "urgent", line_start: 0 };
    bad.extra = true;

    const result = validateContract("review", bad);
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors).toContain('(root): must NOT have additional properties: "extra"');
    expect(errors).toContain(
      "/findings/0/severity: must be equal to one of the allowed values (critical, high, medium, low)",
    );
    expect(errors).toContain("/findings/0/line_start: must be >= 1");
  });

  it("allows the 15 raw findings the Reviewer may produce, but no more", () => {
    // review.raw.json carries up to review.maxRawFindings (15); the Verifier caps the
    // kept list at review.maxFindings (10) and moves the rest to dropped as over_cap.
    const { review } = loadGolden("sample-01-order-outbox");
    const first = review.findings[0];
    if (!first) throw new Error("fixture has no findings");
    const findings = (count: number): typeof review.findings =>
      Array.from({ length: count }, (_, i) => ({
        ...first,
        id: `F${String(i + 1).padStart(2, "0")}`,
      }));

    review.findings = findings(15);
    expect(validateContract("review", review).ok).toBe(true);

    review.findings = findings(16);
    const result = validateContract("review", review);
    expect(result.ok ? [] : result.errors).toContain("/findings: must NOT have more than 15 items");
  });

  it("rejects a script with a single step", () => {
    const { script } = loadGolden("sample-03-email-value-object");
    script.steps = script.steps.slice(0, 1);
    expect(validateContract("script", script).ok).toBe(false);
  });

  it("assertContract throws a ContractError listing the problems", () => {
    expect(() => assertContract("timeline", { schema_version: "1.0" })).toThrow(ContractError);
  });
});

describe("contractFromFileName", () => {
  it.each([
    ["runs/x/ingest.json", "ingest"],
    ["golden/s/ingest.expected.json", "ingest"],
    ["runs/x/review.json", "review"],
    ["runs/x/review.raw.json", "review"],
    ["golden/s/review.expected.json", "review"],
    ["script.json", "script"],
    ["golden\\s\\script.expected.json", "script"],
    ["runs/x/timeline.json", "timeline"],
    ["runs/x/audio/manifest.json", "audio-manifest"],
    ["labels.json", undefined],
  ])("%s -> %s", (file, expected) => {
    expect(contractFromFileName(file)).toBe(expected);
  });
});
