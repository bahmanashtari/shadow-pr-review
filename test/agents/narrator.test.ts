import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assembleScript,
  describeReview,
  narratorOutputSchema,
  runNarrate,
  summarizeNarrate,
  writeScript,
  type NarratorAnswer,
} from "../../src/agents/narrator.js";
import { buildNarratorPrompt } from "../../src/agents/prompts/narrator.js";
import { checkScript } from "../../src/contracts/checks.js";
import type { ReviewResult } from "../../src/contracts/generated/review.js";
import type { NarrationScript } from "../../src/contracts/generated/script.js";
import { validateContract } from "../../src/contracts/validate.js";
import { Budget } from "../../src/harness/budget.js";
import { Tracer } from "../../src/harness/tracing.js";
import { StageError } from "../../src/lib/errors.js";
import { FakeLlmProvider, fakeText } from "../../src/providers/llm/fake.js";
import { GOLDEN_SAMPLES, defaultConfig, loadGolden, TEST_SOURCE } from "../helpers.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spr-narrate-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const HANDLER = "services/order-service/src/application/commands/place-order.handler.ts";
const CONSUMER = "services/inventory-service/src/interface/events/order-placed.consumer.ts";

function review(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    schema_version: "1.0",
    source: { ...TEST_SOURCE, title: "Add PlaceOrder command handler" },
    summary: "Adds a handler that saves an order and publishes an event.",
    findings: [
      {
        id: "F01",
        file: HANDLER,
        side: "new",
        line_start: 19,
        line_end: 27,
        severity: "high",
        category: "event-consistency",
        summary: "The event is published inside the transaction",
        rationale: "If the commit fails, other services hear about an order that was not saved.",
        suggestion: "Use a transactional outbox and publish after the commit.",
        confidence: 0.9,
        evidence: ["      this.events.emit('order.placed', {"],
        verification: { status: "verified" },
      },
      {
        id: "F03",
        file: CONSUMER,
        side: "new",
        line_start: 14,
        line_end: 18,
        severity: "medium",
        category: "idempotency",
        summary: "The consumer decrements stock on every delivery",
        rationale: "Messages can be delivered more than once, so a retry counts the order twice.",
        suggestion: "Record processed event ids and skip anything already handled.",
        confidence: 0.8,
        evidence: ["    await this.stock.decrement(event.sku, event.quantity);"],
        verification: { status: "verified" },
      },
    ],
    dropped: [],
    stats: { files_reviewed: 2, files_skipped: [] },
    ...over,
  };
}

function answer(over: Partial<NarratorAnswer> = {}): NarratorAnswer {
  return {
    steps: [
      {
        finding_id: "F01",
        text: "A high-severity one. The event goes out before the save is final.",
      },
      {
        finding_id: "F03",
        text: "A medium one. A repeated message counts the same order twice.",
      },
    ],
    ...over,
  };
}

/** Runs the stage against scripted model answers, one per turn. */
async function narrate(
  answers: NarratorAnswer[],
  over: { review?: ReviewResult; runDir?: string; budget?: Budget } = {},
): Promise<{ script: NarrationScript; attempts: number; calls: number }> {
  const provider = new FakeLlmProvider(answers.map((a) => fakeText(JSON.stringify(a))));
  const outcome = await runNarrate({
    review: over.review ?? review(),
    provider,
    config: defaultConfig(),
    budget: over.budget ?? new Budget(defaultConfig().budgets),
    tracer: new Tracer(),
    runDir: over.runDir ?? tempDir(),
  });
  return { ...outcome, calls: provider.callCount };
}

/** The parts of the Narrator's schema the tests assert on. */
interface AnswerSchema {
  properties: {
    steps: {
      minItems: number;
      maxItems: number;
      items: { properties: { finding_id: { enum: string[] }; text: { maxLength?: number } } };
    };
  };
}

describe("narratorOutputSchema", () => {
  it("pins the answer to exactly the kept findings, in order", () => {
    const steps = (narratorOutputSchema(review()) as unknown as AnswerSchema).properties.steps;

    expect(steps.minItems).toBe(2);
    expect(steps.maxItems).toBe(2);
    expect(steps.items.properties.finding_id.enum).toEqual(["F01", "F03"]);
  });

  it("takes the text limit from the script contract, so it stays in one place", () => {
    const schema = narratorOutputSchema(review()) as unknown as AnswerSchema;

    expect(schema.properties.steps.items.properties.text.maxLength).toBe(450);
  });
});

describe("assembleScript", () => {
  it("builds one step per finding and nothing else", () => {
    // No intro and no wrap-up: a video explains the issues that were found (ADR-042).
    const script = assembleScript(answer(), review(), defaultConfig());

    expect(script.schema_version).toBe("1.0");
    expect(script.language).toBe("en-US");
    expect(script.steps.map((s) => s.id)).toEqual(["S00", "S01"]);
    expect(script.steps.map((s) => s.finding_id)).toEqual(["F01", "F03"]);
    expect(script.steps.every((s) => s.subtitle === null)).toBe(true);
    expect(validateContract("script", script).ok).toBe(true);
    expect(checkScript(script, review())).toEqual([]);
  });

  it("copies focus from the finding, ids and all, so the screen follows the words", () => {
    const script = assembleScript(answer(), review(), defaultConfig());

    expect(script.steps[0]?.focus).toEqual({
      file: HANDLER,
      side: "new",
      line_start: 19,
      line_end: 27,
    });
    expect(script.steps[1]?.focus).toEqual({
      file: CONSUMER,
      side: "new",
      line_start: 14,
      line_end: 18,
    });
    // Ids come from the review, so a gap there is carried into the script (ADR-023).
    expect(script.steps[1]?.finding_id).toBe("F03");
  });

  it("estimates each step from its word count", () => {
    const one = answer({ steps: [{ finding_id: "F01", text: "one two three four five" }] });
    const script = assembleScript(
      { ...one, steps: [...one.steps, { finding_id: "F03", text: "a b" }] },
      review(),
      defaultConfig(),
    );
    expect(script.steps[0]?.estimated_seconds).toBe(2);
    expect(script.steps[1]?.estimated_seconds).toBe(0.8);
  });

  it("reports a reordered answer rather than narrating the wrong code", () => {
    const swapped = answer({
      steps: [
        { finding_id: "F03", text: "Next, the consumer. A repeated message counts it twice." },
        { finding_id: "F01", text: "First, the event goes out before the save is final." },
      ],
    });
    const problems = checkScript(assembleScript(swapped, review(), defaultConfig()), review());
    expect(problems).toContain("finding steps must follow the order of findings in review.json");
  });

  it("reports a duplicated id as a finding narrated twice and one left out", () => {
    const doubled = answer({
      steps: [
        { finding_id: "F01", text: "First, the event goes out before the save is final." },
        { finding_id: "F01", text: "And again, the same point about the same lines." },
      ],
    });
    const problems = checkScript(assembleScript(doubled, review(), defaultConfig()), review());
    expect(problems).toContain("/steps/1 (S01): finding F01 is narrated twice");
    expect(problems).toContain("finding F03 has no narration step");
  });
});

describe("describeReview", () => {
  it("marks the change summary as context, not as something to repeat", () => {
    // It is the Reviewer's prose, written before verification, and its severity wording can be
    // stale - which is what put "critical" over a `low` finding (ADR-038).
    expect(describeReview(review())).toContain("The change, for context only:");
  });

  it("gives the model the review's words and the lines, and nothing else", () => {
    const text = describeReview(review());

    expect(text).toContain("Adds a handler that saves an order and publishes an event.");
    expect(text).toContain("F01 - high, event-consistency");
    expect(text).toContain("The event is published inside the transaction");
    expect(text).toContain("Use a transactional outbox and publish after the commit.");
    expect(text).toContain("this.events.emit('order.placed', {");
    // Never the diff: nothing that is not in review.json reaches the Narrator.
    expect(text).not.toContain("@@");
  });

  it("names every finding it hands over, in the review's order", () => {
    const text = describeReview(review());
    expect(text).toContain("Narrate these 2 findings, in this order:");
    expect(text.indexOf("F01")).toBeLessThan(text.indexOf("F03"));
  });
});

describe("buildNarratorPrompt", () => {
  it("is built from the narration rules, and carries no findings", () => {
    const prompt = buildNarratorPrompt();
    expect(prompt).toContain("Never read file paths");
    expect(prompt).toContain("40 to 60 words");
    // No intro and no wrap-up, and the severity belongs to the finding (ADR-042).
    expect(prompt).toContain("There is no introduction and no closing summary");
    expect(prompt).toContain("using its own severity word");
    expect(prompt).not.toContain(HANDLER);
  });
});

describe("runNarrate", () => {
  it("writes a valid script when the model answers well the first time", async () => {
    const { script, attempts, calls } = await narrate([answer()]);

    expect(attempts).toBe(0);
    expect(calls).toBe(1);
    expect(checkScript(script, review())).toEqual([]);
    expect(script.steps.map((s) => s.finding_id)).toEqual(["F01", "F03"]);
  });

  it("sends a step that runs long back to the model, and accepts the repair", async () => {
    const tooLong = answer({
      steps: [
        { finding_id: "F01", text: `The event is published early. ${"word ".repeat(70)}` },
        { finding_id: "F03", text: "Next, the consumer counts a repeated message twice." },
      ],
    });
    const { script, attempts } = await narrate([tooLong, answer()]);

    expect(attempts).toBe(1);
    expect(checkScript(script, review())).toEqual([]);
  });

  it("sends markdown back to the model", async () => {
    const withMarkdown = answer({
      steps: [
        { finding_id: "F01", text: "First, the `emit` call runs **inside** the transaction." },
        { finding_id: "F03", text: "Next, the consumer counts a repeated message twice." },
      ],
    });
    const { script, attempts } = await narrate([withMarkdown, answer()]);

    expect(attempts).toBe(1);
    expect(checkScript(script, review())).toEqual([]);
  });

  it("sends a spoken file name back to the model", async () => {
    const withFile = answer({
      steps: [
        { finding_id: "F01", text: "In place-order.handler.ts the event goes out too early." },
        { finding_id: "F03", text: "Next, the consumer counts a repeated message twice." },
      ],
    });
    const { script, attempts } = await narrate([withFile, answer()]);

    expect(attempts).toBe(1);
    expect(checkScript(script, review())).toEqual([]);
  });

  it("fails after the configured repairs, naming what is wrong", async () => {
    const bad = answer({
      steps: [
        { finding_id: "F01", text: "A critical one. The event goes out before the save." },
        { finding_id: "F03", text: "A medium one. A repeated message counts it twice." },
      ],
    });
    await expect(narrate([bad, bad, bad])).rejects.toThrow(StageError);
    await expect(narrate([bad, bad, bad])).rejects.toThrow(/but finding F01 is high/);
  });

  it("leaves the rejected draft behind, and says how to finish it by hand", async () => {
    const runDir = tempDir();
    const bad = answer({
      steps: [
        { finding_id: "F01", text: "A critical one. The event goes out before the save." },
        { finding_id: "F03", text: "A medium one. A repeated message counts it twice." },
      ],
    });

    await expect(narrate([bad, bad, bad], { runDir })).rejects.toThrow(
      /script\.rejected\.json[\s\S]*spr validate script\.json/,
    );

    const file = path.join(runDir, "script.rejected.json");
    expect(existsSync(file)).toBe(true);
    const draft = JSON.parse(readFileSync(file, "utf8")) as NarrationScript;
    // A draft a person can repair in place: only the first step's severity word is wrong.
    expect(validateContract("script", draft).ok).toBe(true);
    expect(draft.steps.map((s) => s.finding_id)).toEqual(["F01", "F03"]);
    expect(draft.steps[0]?.text).toContain("A critical one.");
  });

  it("keeps no draft when the answer never matched the schema, and says so", async () => {
    const runDir = tempDir();
    const provider = new FakeLlmProvider([fakeText("not json at all")], { repeatLastTurn: true });

    await expect(
      runNarrate({
        review: review(),
        provider,
        config: defaultConfig(),
        budget: new Budget(defaultConfig().budgets),
        tracer: new Tracer(),
        runDir,
      }),
    ).rejects.toThrow(/No draft got far enough to keep/);
    expect(existsSync(path.join(runDir, "script.rejected.json"))).toBe(false);
  });

  it("fails rather than narrating nothing when a budget stops the run", async () => {
    const budget = new Budget({ ...defaultConfig().budgets, agentSteps: 0 });
    await expect(narrate([answer()], { budget })).rejects.toThrow(/produced no narration/);
  });

  it("refuses a clean change, because there is no video to make", async () => {
    // ADR-042: a video exists to explain issues that were found. `spr run` stops after Verify
    // rather than reaching here, so this is the message for anyone calling the stage directly.
    const empty = review({ findings: [], summary: "A small, clean change." });
    await expect(narrate([answer({ steps: [] })], { review: empty })).rejects.toThrow(
      /nothing to narrate and no video to make/,
    );
  });
});

describe("writeScript", () => {
  it("writes a script a later stage can read back", () => {
    const runDir = tempDir();
    const script = assembleScript(answer(), review(), defaultConfig());
    writeScript(runDir, script);

    const onDisk: unknown = JSON.parse(readFileSync(path.join(runDir, "script.json"), "utf8"));
    expect(onDisk).toEqual(script);
  });
});

describe("summarizeNarrate", () => {
  it("counts the steps and the seconds", () => {
    const script = assembleScript(answer(), review(), defaultConfig());
    expect(summarizeNarrate({ script, attempts: 0 })).toMatch(
      /^script: 2 steps, about \d+ seconds$/,
    );
  });

  it("says when the model needed repairs", () => {
    const script = assembleScript(answer(), review(), defaultConfig());
    expect(summarizeNarrate({ script, attempts: 2 })).toContain("(2 repaired)");
  });
});

describe("golden set", () => {
  // If a prompt or style change makes the hand-written scripts unreachable, this says so.
  it.each(GOLDEN_SAMPLES)("%s: the expected script passes the narration rules", (sample) => {
    const { review: expected, script } = loadGolden(sample);
    const problems = checkScript(script, expected, {
      maxWordsPerStep: defaultConfig().narration.maxWordsPerStep,
    });
    expect(problems).toEqual([]);
  });

  it.each(GOLDEN_SAMPLES)("%s: one step per kept finding, in order", (sample) => {
    const { review: expected, script } = loadGolden(sample);
    expect(script.steps.map((s) => s.finding_id)).toEqual(expected.findings.map((f) => f.id));
  });
});
