import { describe, expect, it } from "vitest";
import { normalizeForSpeech } from "../../src/tts/normalize.js";

describe("normalizeForSpeech", () => {
  it.each([
    // Every case docs/NARRATION_STYLE.md names.
    ["The NestJS module wires it up.", "The Nest J S module wires it up."],
    ["PostgreSQL will reject that.", "Postgres will reject that."],
    ["postgresql will reject that.", "Postgres will reject that."],
    ["The DTO is validated.", "The D T O is validated."],
    ["CQRS splits reads from writes.", "C Q R S splits reads from writes."],
    ["The `reserved quantity` column.", "The reserved quantity column."],
    ["It handles read/write paths.", "It handles read slash write paths."],
  ])("%s", (input, expected) => {
    expect(normalizeForSpeech(input)).toBe(expected);
  });

  it("puts word boundaries back into a camelCase identifier", () => {
    // Kokoro phonemizes the identifier as one run-together word; spaced, it reads as words
    // with their own stress (ADR-055). Runs of capitals stay whole.
    expect(normalizeForSpeech("The test calls toHaveBeenCalledOnce here.")).toBe(
      "The test calls to Have Been Called Once here.",
    );
    expect(normalizeForSpeech("TypeORM maps the OrderPlaced event.")).toBe(
      "Type ORM maps the Order Placed event.",
    );
    expect(normalizeForSpeech("the `reservedQuantity` column")).toBe(
      "the reserved Quantity column",
    );
  });

  it("leaves an identifier with no case step alone", () => {
    expect(normalizeForSpeech("the stock_item table and the ORM")).toBe(
      "the stock_item table and the ORM",
    );
  });

  it("keeps a plural audible instead of gluing it to the last letter", () => {
    // "D T OS" gets read as a word; a separated "s" is read "ess", which is the plural.
    expect(normalizeForSpeech("the other DTOs are not")).toBe("the other D T O s are not");
    expect(normalizeForSpeech("two CQRS handlers")).toBe("two C Q R S handlers");
  });

  it("leaves text with nothing to fix alone", () => {
    const plain = "Messages can be delivered more than once, but this handler runs every time.";
    expect(normalizeForSpeech(plain)).toBe(plain);
  });

  it("does not fire inside a longer word", () => {
    expect(normalizeForSpeech("The adto and CQRSX tokens.")).toBe("The adto and CQRSX tokens.");
  });

  it("collapses whitespace, so a differently wrapped answer still hits the cache", () => {
    // The cache key is a hash of this output, which is the whole reason it must be stable.
    expect(normalizeForSpeech("  ragged\n  spacing   here ")).toBe("ragged spacing here");
    expect(normalizeForSpeech("one two")).toBe(normalizeForSpeech("one\n\ttwo  "));
  });

  it("is idempotent, so normalizing twice cannot change a cache key", () => {
    const once = normalizeForSpeech("The NestJS DTOs use PostgreSQL, CQRS and toHaveBeenCalled.");
    expect(normalizeForSpeech(once)).toBe(once);
  });
});
