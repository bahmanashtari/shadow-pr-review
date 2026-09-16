import { describe, expect, it } from "vitest";
import { checkReview, checkScript } from "../../src/contracts/checks.js";
import { validateContract } from "../../src/contracts/validate.js";
import { GOLDEN_SAMPLES, loadGolden, readGoldenJson } from "../helpers.js";

describe("golden set", () => {
  it("contains the three expected samples", () => {
    expect(GOLDEN_SAMPLES).toEqual([
      "sample-01-order-outbox",
      "sample-02-inventory-consumer",
      "sample-03-email-value-object",
    ]);
  });

  describe.each(GOLDEN_SAMPLES)("%s", (sample) => {
    it("review.expected.json matches the review schema", () => {
      const result = validateContract("review", readGoldenJson(sample, "review.expected.json"));
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("script.expected.json matches the script schema", () => {
      const result = validateContract("script", readGoldenJson(sample, "script.expected.json"));
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("passes the cross-field checks", () => {
      const { review, script } = loadGolden(sample);
      expect(checkReview(review)).toEqual([]);
      expect(checkScript(script, review)).toEqual([]);
    });

    it("labels.json refers to the sample", () => {
      const labels = readGoldenJson(sample, "labels.json") as { sample?: unknown };
      expect(labels.sample).toBe(sample);
    });
  });
});
