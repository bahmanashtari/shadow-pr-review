import { describe, expect, it } from "vitest";
import { buildSrt, cuesFor, cuesForStep, timestamp, wrapLines } from "../../src/composer/srt.js";
import { buildTimeline } from "../../src/director/timeline.js";
import { runTts } from "../../src/tts/speak.js";
import { FakeTtsProvider } from "../../src/providers/tts/fake.js";
import type { NarrationScript } from "../../src/contracts/generated/script.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, GOLDEN_SAMPLES, loadGolden } from "../helpers.js";

describe("timestamp", () => {
  it.each([
    [0, "00:00:00,000"],
    [1, "00:00:00,001"],
    [999, "00:00:00,999"],
    [1000, "00:00:01,000"],
    [61_000, "00:01:01,000"],
    [3_723_456, "01:02:03,456"],
  ])("%i ms -> %s", (ms, expected) => {
    expect(timestamp(ms)).toBe(expected);
  });

  it("uses a comma for the decimal, which is what SRT requires", () => {
    expect(timestamp(1500)).toContain(",");
    expect(timestamp(1500)).not.toContain(".");
  });

  it("never goes negative", () => {
    expect(timestamp(-500)).toBe("00:00:00,000");
  });
});

describe("wrapLines", () => {
  it("keeps every line within the width", () => {
    const text = "Messages can be delivered more than once, but this handler runs every time.";
    for (const line of wrapLines(text)) expect(line.length).toBeLessThanOrEqual(42);
  });

  it("never breaks a word", () => {
    const text = "The reserved quantity column has an extraordinarily descriptive name here.";
    for (const line of wrapLines(text)) {
      for (const word of line.split(" ")) expect(text).toContain(word);
    }
    expect(wrapLines(text).join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("gives a word longer than the width a line of its own rather than cutting it", () => {
    const long = "supercalifragilisticexpialidociousandthensome_identifier_name_here";
    const lines = wrapLines(`a ${long} b`);
    expect(lines).toContain(long);
  });

  it("returns nothing for empty text", () => {
    expect(wrapLines("   ")).toEqual([]);
  });
});

describe("cuesForStep", () => {
  it("keeps a short step as one cue spanning its whole window", () => {
    const cues = cuesForStep("Short enough for one cue.", 1000, 5000);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ start_ms: 1000, end_ms: 5000 });
  });

  it("splits a long step into cues of at most two lines", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const cues = cuesForStep(long, 0, 20_000);
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) expect(cue.lines.length).toBeLessThanOrEqual(2);
  });

  it("divides the window proportionally and leaves no gaps between cues", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const cues = cuesForStep(long, 4000, 24_000);
    cues.forEach((cue, i) => {
      expect(cue.end_ms).toBeGreaterThan(cue.start_ms);
      const previous = cues[i - 1];
      if (previous) expect(cue.start_ms).toBe(previous.end_ms);
    });
  });

  it("ends the last cue exactly on the window, not on a rounded approximation", () => {
    // A cue that stopped early would be invisible; one that overran would collide with the
    // next step's first cue.
    const long = Array.from({ length: 37 }, (_, i) => `w${i}`).join(" ");
    const cues = cuesForStep(long, 1234, 9877);
    expect(cues[0]?.start_ms).toBe(1234);
    expect(cues.at(-1)?.end_ms).toBe(9877);
  });

  it("returns nothing for a step with no words", () => {
    expect(cuesForStep("  ", 0, 1000)).toEqual([]);
  });
});

describe("cuesForStep: no orphan cues", () => {
  /* The defect ADR-034 watched: greedy wrapping filled lines to the margin and paired them,
   * so whatever did not divide by two became a trailing cue of its own - and proportional
   * timing gave it a proportional share of nothing. "layer." held the screen for 415 ms. */
  const ORPHANED = [
    "Next, a domain boundary violation. The handler uses the ORM directly and an entity. This",
    "couples the business logic to the database. It makes testing hard and breaks domain",
    "separation. Instead, use a repository interface from the domain layer.",
  ].join(" ");

  it("gives the text that used to end in a 415 ms flash an even split", () => {
    // The real step, at the window the Director measured for it.
    const cues = cuesForStep(ORPHANED, 28_610, 45_177);
    const durations = cues.map((c) => c.end_ms - c.start_ms);

    expect(Math.min(...durations)).toBeGreaterThan(2000);
    // No cue carries a fraction of what its siblings do any more.
    const sizes = cues.map((c) => c.lines.join(" ").length);
    expect(Math.min(...sizes) / Math.max(...sizes)).toBeGreaterThan(0.6);
  });

  it("spends no more cues than the text needs", () => {
    // Legibility bought with churn would be a different bug: the count is what the text's
    // length asks for, which is what it was before.
    expect(cuesForStep(ORPHANED, 0, 16_567)).toHaveLength(4);
  });

  it("holds the two-line ceiling even for a word longer than a whole cue", () => {
    // `wrapLines` gives an over-long word a line of its own rather than cutting it, so the
    // widening loop has to terminate on the word count rather than on the line count.
    const monster = "a".repeat(200);
    const cues = cuesForStep(`Look at ${monster} closely.`, 0, 10_000);
    for (const cue of cues) expect(cue.lines.length).toBeLessThanOrEqual(2);
    expect(cues.at(-1)?.end_ms).toBe(10_000);
  });

  it("keeps one word as one cue", () => {
    expect(cuesForStep("Merged.", 0, 1000)).toEqual([
      { start_ms: 0, end_ms: 1000, lines: ["Merged."] },
    ]);
  });
});

describe("cuesFor", () => {
  /** A golden script, spoken by the fake provider, directed into a timeline. */
  async function golden(sample: string) {
    const script = loadGolden(sample).script;
    const { manifest } = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir: mkdtempSync(path.join(tmpdir(), "spr-srt-")),
    });
    return { script, timeline: buildTimeline(script, manifest, defaultConfig()) };
  }

  it("prefers a step's subtitle over its spoken text, which is what the field is for", async () => {
    const { script, timeline } = await golden(GOLDEN_SAMPLES[0] ?? "sample-01-order-outbox");
    const withSubtitle: NarrationScript = {
      ...script,
      steps: script.steps.map((s, i) => (i === 0 ? { ...s, subtitle: "On screen instead." } : s)),
    };
    expect(cuesFor(timeline, withSubtitle)[0]?.lines.join(" ")).toBe("On screen instead.");
  });

  it.each(GOLDEN_SAMPLES)("%s produces cues inside their step windows", async (sample) => {
    const { script, timeline } = await golden(sample);
    const cues = cuesFor(timeline, script);
    expect(cues.length).toBeGreaterThan(0);

    const first = timeline.step_windows[0];
    const last = timeline.step_windows.at(-1);
    expect(cues[0]?.start_ms).toBe(first?.start_ms);
    expect(cues.at(-1)?.end_ms).toBe(last?.end_ms);
  });
});

describe("the minimum a cue may be shown for", () => {
  /*
   * Plan m3-step10 Q2: this lives here rather than as a clamp in `cuesForStep`, because a
   * clamp would be unreachable. A step's window is the measured duration of that very text
   * (ADR-027), so a cue holding fifty characters cannot be handed 400 ms - fifty characters
   * take about two seconds to say. Asserting it over the fixtures documents the number and
   * fails loudly if the splitting ever regresses; defensive code nobody can trigger does not.
   */
  const FLOOR_MS = 1200;

  it.each(GOLDEN_SAMPLES)("%s: no cue is shown for less than %i ms", async (sample) => {
    const { script } = loadGolden(sample);
    const runDir = mkdtempSync(path.join(tmpdir(), "spr-srt-"));
    const config = defaultConfig();
    const { manifest } = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config,
      runDir,
    });
    const cues = cuesFor(buildTimeline(script, manifest, config), script);

    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      const shown = cue.end_ms - cue.start_ms;
      expect(shown, `cue ${JSON.stringify(cue.lines)} is shown for ${shown} ms`).toBeGreaterThan(
        FLOOR_MS,
      );
      expect(cue.lines.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("buildSrt", () => {
  it("numbers cues from one and separates blocks with a blank line", async () => {
    const script = loadGolden(GOLDEN_SAMPLES[0] ?? "sample-01-order-outbox").script;
    const { manifest } = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir: mkdtempSync(path.join(tmpdir(), "spr-srt-")),
    });
    const srt = buildSrt(buildTimeline(script, manifest, defaultConfig()), script);

    expect(srt.startsWith("1\n")).toBe(true);
    expect(srt).toMatch(/^\d+\n\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d\n/m);
    expect(srt.endsWith("\n")).toBe(true);

    const numbers = [...srt.matchAll(/^(\d+)$/gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});
