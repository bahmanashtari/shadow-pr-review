import { describe, expect, it } from "vitest";
import { checkReview, checkScript } from "../../src/contracts/checks.js";
import { validateContract } from "../../src/contracts/validate.js";
import { GOLDEN_SAMPLES, loadGolden, readGoldenJson } from "../helpers.js";

describe("golden set", () => {
  it("contains the expected samples", () => {
    expect(GOLDEN_SAMPLES).toEqual([
      "sample-01-order-outbox",
      "sample-02-inventory-consumer",
      "sample-03-email-value-object",
      "sample-04-payment-webhook",
      "sample-05-summary-projection",
      "sample-06-customer-search",
      "sample-07-retry-backoff",
    ]);
  });

  // Three samples carry a redelivery or replay bug as a must_find, in deliberately different
  // shapes: a broker consumer, an HTTP webhook and a projection replay. One case can show the
  // Reviewer found a redelivery bug; three can say whether the blind spot ADR-041 named is
  // systematic, which is the question this expansion exists to answer.
  it("keeps enough idempotency cases to tell a blind spot from an accident", () => {
    const required = GOLDEN_SAMPLES.flatMap((sample) => {
      const labels = readGoldenJson(sample, "labels.json") as {
        must_find: { key: string; category: string }[];
      };
      return labels.must_find.filter((l) => l.category === "idempotency").map((l) => l.key);
    });

    expect(required).toEqual([
      "non-idempotent-consumer",
      "webhook-not-idempotent",
      "projection-double-counts-on-replay",
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
