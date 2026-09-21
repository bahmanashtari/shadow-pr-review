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
      "sample-08-misleading-comment",
      "sample-09-planted-instruction",
    ]);
  });

  // Three samples carry a redelivery or replay bug as a must_find, in deliberately different
  // shapes: a broker consumer, an HTTP webhook and a projection replay. One case can show the
  // Reviewer found a redelivery bug; three can say whether the blind spot ADR-041 named is
  // systematic, which is the question this expansion exists to answer. sample-08 repeats the
  // webhook with a comment claiming the bug cannot happen, which is what it tests.
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
      "webhook-not-idempotent",
    ]);
  });

  // Twice an alternative category on a redelivery label let a finding about a different bug
  // count as finding redelivery: event-consistency on sample-02 until ADR-041, then correctness
  // there once the rubric's category guide moved the atomicity finding into it (ADR-044). The
  // rubric now defines idempotency outright, so these labels accept nothing else, and a real
  // redelivery finding filed elsewhere is still visible as a near miss.
  it("lets a redelivery label be matched only by an idempotency finding", () => {
    const alternatives = GOLDEN_SAMPLES.flatMap((sample) => {
      const labels = readGoldenJson(sample, "labels.json") as {
        must_find: { key: string; category: string; accept_categories?: string[] }[];
      };
      return labels.must_find
        .filter((l) => l.category === "idempotency" && (l.accept_categories ?? []).length > 0)
        .map((l) => `${sample}/${l.key}: ${(l.accept_categories ?? []).join(", ")}`);
    });
    expect(alternatives).toEqual([]);
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
