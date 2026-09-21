import { describe, expect, it } from "vitest";
import { buildIngest } from "../../src/ingest/ingest.js";
import { HunkIndex, normalizeSnippet, quotedText } from "../../src/ingest/hunk-index.js";
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

  it("accepts a copied prefix on a context line, whose marker is a space", () => {
    // sample-06 is the first golden diff that modifies files. Its context lines are rendered
    // "   3   import ..." and a model copied one as "3 import ...".
    const search = indexOf(readGoldenDiff("sample-06-customer-search"));
    const controller = "services/customer-service/src/interface/http/customer.controller.ts";
    const imported =
      "import { CustomerRepository } from '../../infrastructure/persistence/customer.repository';";
    expect(search.containsSnippet(controller, `3 ${imported}`)).toBe(true);
    expect(search.containsSnippet(controller, `   9     @UseGuards(JwtAuthGuard)`)).toBe(true);
    // Still verified against the line it claims: line 4 is not the import.
    expect(search.containsSnippet(controller, `4 ${imported}`)).toBe(false);
    // And a snippet that happens to start with a number is not changed when it matches as-is.
    expect(search.containsSnippet(controller, "@Get(':id')")).toBe(true);
  });

  describe("a quote whose line breaks were replaced (ADR-046)", () => {
    const projection = indexOf(readGoldenDiff("sample-05-summary-projection"));
    const PROJECTION =
      "services/reporting-service/src/infrastructure/projections/order-summary.projection.ts";

    it("matches the quote that lost sample-05's replay finding, seven lines joined into one", () => {
      // Exactly what qwen3:30b wrote: "query(" and "`UPDATE" joined with nothing, the rest
      // with single spaces.
      const quoted =
        "    await this.dataSource.query(`UPDATE order_summary SET orders = orders + 1, revenue = " +
        "revenue + $2 WHERE customer_id = $1`, [event.customerId, event.total],);";
      expect(projection.containsSnippet(PROJECTION, quoted)).toBe(true);
    });

    it("accepts a join with a space and a join with nothing alike", () => {
      expect(
        projection.containsSnippet(PROJECTION, "`UPDATE order_summary SET orders = orders + 1,"),
      ).toBe(true);
      expect(
        projection.containsSnippet(PROJECTION, "`UPDATE order_summarySET orders = orders + 1,"),
      ).toBe(true);
    });

    it("still refuses a paraphrase, however close", () => {
      expect(
        projection.containsSnippet(PROJECTION, "`UPDATE order_summary SET orders = orders + 2,"),
      ).toBe(false);
    });

    it("does not join lines across two hunks", () => {
      const twoHunks = indexOf(readDiffFixture("multi-hunk.patch"));
      expect(twoHunks.containsSnippet("src/service.ts", "export class Service {")).toBe(true);
      expect(
        twoHunks.containsSnippet(
          "src/service.ts",
          "export class Service { async run(): Promise<void> {",
        ),
      ).toBe(false);
    });

    it("does not span more than twelve lines", () => {
      // The whole 19-line handler of sample-05, joined: real text, but no longer a quote.
      const everything = readGoldenDiff("sample-05-summary-projection")
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .slice(0, 19)
        .map((line) => line.slice(1))
        .join(" ");
      expect(projection.containsSnippet(PROJECTION, everything)).toBe(false);
    });
  });

  it("reads a quote without its prefix, and a blank quote as empty", () => {
    expect(quotedText("19 +    await this.dataSource.transaction(async (manager) => {")).toBe(
      "await this.dataSource.transaction(async (manager) => {",
    );
    // qwen3:4b's third quote on sample-01: line 21 is blank.
    expect(quotedText("21 +      ")).toBe("");
    expect(quotedText("   ")).toBe("");
    expect(quotedText("return order.id;")).toBe("return order.id;");
  });

  it("knows which lines a change touched, and which are only context (step 15)", () => {
    const search = indexOf(readGoldenDiff("sample-06-customer-search"));
    const controller = "services/customer-service/src/interface/http/customer.controller.ts";
    // Line 9 is the guard on the existing route: in the diff, but unchanged.
    expect(search.hasRange(controller, "new", 9, 9)).toBe(true);
    expect(search.touchesChange(controller, "new", 9, 9)).toBe(false);
    expect(search.touchesChange(controller, "new", 1, 13)).toBe(false);
    // The new route is added; a range reaching into it counts.
    expect(search.touchesChange(controller, "new", 15, 17)).toBe(true);
    expect(search.touchesChange(controller, "new", 12, 15)).toBe(true);
    // A removed line counts on the old side, and only there.
    const modified = indexOf(readDiffFixture("multi-hunk.patch"));
    expect(modified.touchesChange("src/service.ts", "old", 23, 23)).toBe(true);
    expect(modified.touchesChange("src/service.ts", "new", 23, 23)).toBe(false);
    expect(modified.touchesChange("src/service.ts", "new", 24, 24)).toBe(true);
    expect(search.touchesChange("nope.ts", "new", 1, 1)).toBe(false);
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
