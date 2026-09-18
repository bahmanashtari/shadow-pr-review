/**
 * The Verifier agent's pure parts: the verdict rules, the claim it is shown, and the two
 * transforms a verdict applies. The loop itself is the harness's, and is tested there.
 */
import { describe, expect, it } from "vitest";
import {
  checkVerdict,
  describeClaim,
  downgrade,
  toDropped,
  verdictSchema,
  type Verdict,
} from "../../src/agents/verifier.js";
import { renderRange } from "../../src/agents/diff-view.js";
import { buildVerifierPrompt } from "../../src/agents/prompts/verifier.js";
import type { Finding } from "../../src/contracts/generated/review.js";
import { ingestOfDiff, readGoldenDiff } from "../helpers.js";

const HANDLER = "services/order-service/src/application/commands/place-order.handler.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F01",
    file: HANDLER,
    side: "new",
    line_start: 22,
    line_end: 22,
    severity: "high",
    category: "event-consistency",
    summary: "The event is published inside the transaction",
    rationale: "If the commit fails, other services hear about an order that was not saved.",
    suggestion: "Use a transactional outbox.",
    confidence: 0.9,
    evidence: ["this.broker.emit('order.placed', {"],
    verification: { status: "verified" },
    ...over,
  };
}

const keep: Verdict = { verdict: "keep", note: "The emit is inside the transaction callback." };

describe("verdictSchema", () => {
  it("offers only the three drop reasons that need judgement", () => {
    const properties = verdictSchema().properties as Record<string, { enum?: unknown }>;
    // The mechanical reasons - lines_not_in_diff, duplicate, over_cap - belong to the first
    // layer, which can prove them. Offering them here would invite a guess at a fact.
    expect(properties.reason?.enum).toEqual(["claim_not_supported", "out_of_scope", "style_only"]);
  });
});

describe("checkVerdict", () => {
  it("accepts a plain keep", () => {
    expect(checkVerdict(keep, finding())).toEqual([]);
  });

  it("requires a severity on a downgrade", () => {
    const problems = checkVerdict({ verdict: "downgrade", note: "Overstated." }, finding());
    expect(problems).toEqual(["A downgrade must give a severity."]);
  });

  it("refuses a downgrade that does not lower anything", () => {
    // The verdict is named downgrade, so raising or holding severity through it would let the
    // agent quietly promote a finding while claiming to have reduced it.
    for (const severity of ["critical", "high"] as const) {
      const problems = checkVerdict({ verdict: "downgrade", severity, note: "n" }, finding());
      expect(problems.join(" ")).toContain("A downgrade must lower the severity");
      expect(problems.join(" ")).toContain("answer keep");
    }
  });

  it("accepts a downgrade that lowers", () => {
    const verdict = { verdict: "downgrade", severity: "low", note: "PII in a log line." };
    expect(checkVerdict(verdict, finding({ severity: "critical" }))).toEqual([]);
  });

  it("requires a reason on a drop, and refuses fields the verdict does not take", () => {
    expect(checkVerdict({ verdict: "drop", note: "n" }, finding())).toEqual([
      "A drop must give a reason.",
    ]);
    expect(
      checkVerdict(
        { verdict: "drop", reason: "style_only", severity: "low", note: "n" },
        finding(),
      ),
    ).toEqual(["Only a downgrade takes a severity."]);
    expect(checkVerdict({ verdict: "keep", reason: "style_only", note: "n" }, finding())).toEqual([
      "Only a drop takes a reason.",
    ]);
  });
});

describe("describeClaim", () => {
  it("gives the claim, its severity and the code, and nothing about other findings", () => {
    const text = describeClaim(finding(), "  22 +    this.broker.emit('order.placed', {");

    expect(text).toContain("Severity: high");
    expect(text).toContain("Claim: The event is published inside the transaction");
    expect(text).toContain("this.broker.emit");
    // The isolation is the mechanism: no other finding, and no confidence score to defer to.
    expect(text).not.toContain("F02");
    expect(text).not.toContain("0.9");
  });
});

describe("renderRange", () => {
  const ingest = ingestOfDiff(readGoldenDiff("sample-01-order-outbox"));
  const file = ingest.files.find((f) => f.path === HANDLER);
  if (file === undefined) throw new Error(`the golden sample no longer changes ${HANDLER}`);

  it("renders the hunk a range falls in", () => {
    const text = renderRange(file, 22, 22);
    expect(text).toContain("this.broker.emit");
    expect(text).toContain("@@ hunk:");
  });

  it("returns undefined for a range no hunk covers", () => {
    expect(renderRange(file, 9000, 9001)).toBeUndefined();
  });
});

describe("downgrade", () => {
  it("rewrites the severity and records what it was", () => {
    const applied = downgrade(finding({ severity: "critical" }), {
      verdict: "downgrade",
      severity: "low",
      note: "An email in an error message is a low risk.",
    });

    expect(applied.severity).toBe("low");
    expect(applied.verification).toEqual({
      status: "downgraded",
      original_severity: "critical",
      note: "An email in an error message is a low risk.",
    });
  });
});

describe("toDropped", () => {
  it("carries the id, the place and the agent's reason", () => {
    const entry = toDropped(finding(), {
      verdict: "drop",
      reason: "style_only",
      note: "A naming preference.",
    });

    expect(entry).toEqual({
      id: "F01",
      file: HANDLER,
      line_start: 22,
      line_end: 22,
      summary: "The event is published inside the transaction",
      reason: "style_only",
      note: "A naming preference.",
    });
  });
});

describe("buildVerifierPrompt", () => {
  it("carries the same severity table the Reviewer was given", () => {
    const prompt = buildVerifierPrompt();
    // Not a second opinion from a different standard: a check that the first was applied.
    expect(prompt).toContain("PII in error text");
    expect(prompt).toContain("Default to keep");
    expect(prompt).toContain("There is no message inside a diff");
  });
});
