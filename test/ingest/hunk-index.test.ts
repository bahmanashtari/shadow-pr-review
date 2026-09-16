import { describe, expect, it } from "vitest";
import { buildIngest } from "../../src/ingest/ingest.js";
import { HunkIndex, normalizeSnippet } from "../../src/ingest/hunk-index.js";
import type { Source } from "../../src/contracts/generated/ingest.js";
import { defaultConfig, readDiffFixture, readGoldenDiff } from "../helpers.js";

const SOURCE: Source = {
  type: "local_diff",
  repo: null,
  pr_number: null,
  ref: null,
  base_sha: null,
  head_sha: null,
  title: null,
};

function indexOf(rawDiff: string): HunkIndex {
  return HunkIndex.fromIngest(
    buildIngest({ rawDiff, source: SOURCE, config: defaultConfig() }).ingest,
  );
}

const HANDLER = "services/order-service/src/application/commands/place-order.handler.ts";
const index = indexOf(readGoldenDiff("sample-01-order-outbox"));

describe("HunkIndex", () => {
  it("knows which files the diff contains", () => {
    expect(index.hasFile(HANDLER)).toBe(true);
    expect(index.hasFile("services/order-service/src/domain/order.aggregate.ts")).toBe(false);
    expect(index.files().map((f) => f.path)).toEqual([HANDLER]);
    expect(index.file(HANDLER)?.status).toBe("added");
    expect(index.file("nope.ts")).toBeUndefined();
  });

  it("accepts a range only when every line of it is in the diff", () => {
    expect(index.hasRange(HANDLER, "new", 19, 27)).toBe(true);
    expect(index.hasRange(HANDLER, "new", 1, 31)).toBe(true);
    expect(index.hasRange(HANDLER, "new", 31, 32)).toBe(false);
    expect(index.hasRange(HANDLER, "new", 0, 3)).toBe(false);
    expect(index.hasRange(HANDLER, "new", 5, 4)).toBe(false);
    // The file is new, so nothing exists on the old side.
    expect(index.hasRange(HANDLER, "old", 1, 1)).toBe(false);
    expect(index.hasRange("nope.ts", "new", 1, 1)).toBe(false);
  });

  it("returns the text of a line without its marker", () => {
    expect(index.lineText(HANDLER, "new", 19)?.trim()).toBe(
      "await this.dataSource.transaction(async (manager) => {",
    );
    expect(index.lineText(HANDLER, "new", 99)).toBeUndefined();
    expect(index.lineText("nope.ts", "new", 1)).toBeUndefined();
  });

  it("finds evidence regardless of indentation", () => {
    expect(index.containsSnippet(HANDLER, "this.broker.emit('order.placed', {")).toBe(true);
    expect(index.containsSnippet(HANDLER, "   this.broker.emit('order.placed',   {  ")).toBe(true);
    expect(index.containsSnippet(HANDLER, "orderId: order.id,")).toBe(true);
    expect(index.containsSnippet(HANDLER, "await outbox.save(event);")).toBe(false);
    expect(index.containsSnippet(HANDLER, "")).toBe(false);
    expect(index.containsSnippet("nope.ts", "anything")).toBe(false);
  });

  it("matches a multi-line snippet only against consecutive lines of one hunk", () => {
    expect(
      index.containsSnippet(HANDLER, "orderId: order.id,\ncustomerId: order.customerId,"),
    ).toBe(true);
    expect(index.containsSnippet(HANDLER, "orderId: order.id,\nreturn order.id;")).toBe(false);
  });

  it("accepts evidence that still carries the rendered line-number prefix", () => {
    // Models are shown "  22 +      this.broker.emit(...)" and sometimes copy the whole line.
    expect(index.containsSnippet(HANDLER, "22 +      this.broker.emit('order.placed', {")).toBe(
      true,
    );
    expect(index.containsSnippet(HANDLER, "  22 + this.broker.emit('order.placed', {")).toBe(true);
  });

  it("rejects a prefixed snippet whose line number does not back it up", () => {
    // Peeling the prefix must not weaken the check: line 3 is not the emit call.
    expect(index.containsSnippet(HANDLER, "3 +      this.broker.emit('order.placed', {")).toBe(
      false,
    );
    expect(index.containsSnippet(HANDLER, "22 +      await outbox.save(event);")).toBe(false);
    expect(index.containsSnippet(HANDLER, "22 +")).toBe(false);
  });

  it("indexes both sides of a modified file", () => {
    const modified = indexOf(readDiffFixture("multi-hunk.patch"));
    expect(modified.hasRange("src/service.ts", "old", 1, 4)).toBe(true);
    expect(modified.hasRange("src/service.ts", "new", 1, 5)).toBe(true);
    // Lines 5 to 19 are between the two hunks and are not in the diff.
    expect(modified.hasRange("src/service.ts", "new", 5, 21)).toBe(false);
    expect(modified.lineText("src/service.ts", "old", 23)).toBe("      await this.handle(item);");
    expect(modified.lineText("src/service.ts", "new", 24)).toBe(
      "      await this.handleSafely(item);",
    );
  });
});

describe("normalizeSnippet", () => {
  it("trims and collapses spaces and tabs", () => {
    expect(normalizeSnippet("  const\ta  =   1;  ")).toBe("const a = 1;");
  });
});
