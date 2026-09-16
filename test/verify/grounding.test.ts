import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/contracts/generated/review.js";
import { HunkIndex } from "../../src/ingest/hunk-index.js";
import { checkGrounded, sameClaim, screenFindings } from "../../src/verify/grounding.js";
import { ingestOfDiff, readDiffFixture, readGoldenDiff } from "../helpers.js";

const HANDLER = "services/order-service/src/application/commands/place-order.handler.ts";
const TRANSACTION = "await this.dataSource.transaction(async (manager) => {";

const index = HunkIndex.fromIngest(ingestOfDiff(readGoldenDiff("sample-01-order-outbox")));
/** A modified file, so the old side has lines to point at. */
const modified = HunkIndex.fromIngest(ingestOfDiff(readDiffFixture("multi-hunk.patch")));

/** A grounded finding about lines 19 and 20 of the handler; `over` breaks one thing at a time. */
function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F01",
    file: HANDLER,
    side: "new",
    line_start: 19,
    line_end: 20,
    severity: "high",
    category: "event-consistency",
    summary: "Event published before commit",
    rationale: "The emit runs inside the transaction callback.",
    suggestion: "Use a transactional outbox.",
    confidence: 0.9,
    evidence: [TRANSACTION],
    ...over,
  };
}

describe("checkGrounded", () => {
  it("keeps a finding whose file, lines and evidence are all in the diff", () => {
    expect(checkGrounded(index, finding())).toBeNull();
  });

  it("drops a finding about a file the change never touched", () => {
    const rejection = checkGrounded(index, finding({ file: "services/order-service/src/main.ts" }));
    expect(rejection?.reason).toBe("out_of_scope");
    expect(rejection?.note).toContain("main.ts");
  });

  it("drops a range that runs past the end of the diff", () => {
    const rejection = checkGrounded(index, finding({ line_start: 30, line_end: 40 }));
    expect(rejection?.reason).toBe("lines_not_in_diff");
    expect(rejection?.note).toContain("30-40");
  });

  it("drops an old-side range on a file the change adds", () => {
    expect(checkGrounded(index, finding({ side: "old" }))?.reason).toBe("lines_not_in_diff");
  });

  it("keeps an old-side range on a deleted line", () => {
    const deleted = finding({
      file: "src/service.ts",
      side: "old",
      line_start: 23,
      line_end: 23,
      evidence: ["await this.handle(item);"],
    });
    expect(checkGrounded(modified, deleted)).toBeNull();
  });

  it("drops paraphrased evidence and says which snippet failed", () => {
    const rejection = checkGrounded(
      index,
      finding({ evidence: [TRANSACTION, "the handler emits the event inside the transaction"] }),
    );
    expect(rejection?.reason).toBe("claim_not_supported");
    expect(rejection?.note).toContain("evidence 2 of 2");
    expect(rejection?.note).toContain("the handler emits");
  });

  it("keeps evidence that differs only in indentation", () => {
    expect(checkGrounded(index, finding({ evidence: [`      ${TRANSACTION}   `] }))).toBeNull();
  });

  it("keeps evidence that copied the rendered line-number prefix (ADR-020)", () => {
    expect(checkGrounded(index, finding({ evidence: [`  19 + ${TRANSACTION}`] }))).toBeNull();
  });

  it("drops a prefixed snippet whose line number does not back it up", () => {
    const rejection = checkGrounded(index, finding({ evidence: [`  21 + ${TRANSACTION}`] }));
    expect(rejection?.reason).toBe("claim_not_supported");
  });

  it("keeps evidence quoted from outside the claimed range", () => {
    // sample-01 F02 points at lines 19-20 and quotes the import on line 2, which is exactly
    // how that claim should be supported. Evidence is checked against the file, not the range.
    const withImport = finding({ evidence: ["import { DataSource } from 'typeorm';"] });
    expect(checkGrounded(index, withImport)).toBeNull();
  });
});

describe("sameClaim", () => {
  it("is true for the same file and category on overlapping lines", () => {
    expect(sameClaim(finding(), finding({ id: "F02", line_start: 20, line_end: 27 }))).toBe(true);
  });

  it("is false for a different category on the same lines", () => {
    expect(sameClaim(finding(), finding({ id: "F02", category: "ddd-boundaries" }))).toBe(false);
  });

  it("is false for the same category on lines that do not overlap", () => {
    expect(sameClaim(finding(), finding({ id: "F02", line_start: 1, line_end: 2 }))).toBe(false);
  });
});

/** Screens findings with the shipped cap unless a test needs a smaller one. */
function screen(findings: readonly Finding[], maxFindings = 10) {
  return screenFindings({ index, findings, maxFindings });
}

describe("screenFindings", () => {
  it("drops the weaker of two findings that make the same claim", () => {
    const strong = finding();
    const weak = finding({ id: "F02", severity: "medium", line_start: 20, line_end: 22 });
    const { kept, dropped } = screen([strong, weak]);

    expect(kept.map((f) => f.id)).toEqual(["F01"]);
    expect(dropped[0]?.rejection.reason).toBe("duplicate");
    expect(dropped[0]?.rejection.note).toContain("F01");
  });

  it("breaks a severity tie on confidence", () => {
    const sure = finding({ id: "F02", confidence: 0.9 });
    const unsure = finding({ id: "F01", confidence: 0.4 });
    expect(screen([unsure, sure]).kept.map((f) => f.id)).toEqual(["F02"]);
  });

  it("keeps two findings on the same lines in different categories", () => {
    const findings = [finding(), finding({ id: "F02", category: "ddd-boundaries" })];
    expect(screen(findings).kept).toHaveLength(2);
  });

  it("keeps two findings in the same category that do not overlap", () => {
    const early = finding({ id: "F02", line_start: 1, line_end: 2 });
    expect(screen([finding(), early]).kept).toHaveLength(2);
  });

  it("never lets an ungrounded finding shadow its grounded duplicate", () => {
    const ungrounded = finding({ id: "F01", severity: "critical", evidence: ["made up"] });
    const grounded = finding({ id: "F02", severity: "medium" });
    const { kept, dropped } = screen([ungrounded, grounded]);

    expect(kept.map((f) => f.id)).toEqual(["F02"]);
    expect(dropped.map((d) => d.rejection.reason)).toEqual(["claim_not_supported"]);
  });

  it("cuts for space only after everything unprovable is gone", () => {
    // Twelve grounded, non-overlapping findings; the two on lines 1 and 2 are the least severe.
    const many = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13].map((line, i) =>
      finding({
        id: `F${String(i + 1).padStart(2, "0")}`,
        line_start: line,
        line_end: line,
        severity: line <= 2 ? "low" : "high",
      }),
    );
    const { kept, dropped } = screen(many);

    expect(kept).toHaveLength(10);
    expect(dropped.map((d) => d.finding.line_start)).toEqual([1, 2]);
    expect(dropped.every((d) => d.rejection.reason === "over_cap")).toBe(true);
  });

  it("returns the kept findings ordered by severity, then file and line", () => {
    const findings = [
      finding({ id: "F01", line_start: 22, line_end: 22, severity: "low" }),
      finding({ id: "F02", line_start: 1, line_end: 1, severity: "low" }),
      finding({ id: "F03", line_start: 12, line_end: 12, severity: "critical" }),
    ];
    expect(screen(findings).kept.map((f) => f.id)).toEqual(["F03", "F02", "F01"]);
  });

  it("lists dropped findings in id order, whichever check removed them", () => {
    const findings = [
      finding({ id: "F01" }),
      finding({ id: "F02", line_start: 40, line_end: 40 }),
      finding({ id: "F03", evidence: ["not in the diff"] }),
    ];
    expect(screen(findings).dropped.map((d) => d.finding.id)).toEqual(["F02", "F03"]);
  });
});
