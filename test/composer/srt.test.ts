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
