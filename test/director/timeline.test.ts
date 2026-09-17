import { describe, expect, it } from "vitest";
import { buildTimeline } from "../../src/director/timeline.js";
import { runDirect, summarizeDirect } from "../../src/director/direct.js";
import { summarizeFindings } from "../../src/director/outro.js";
import { checkTimeline } from "../../src/contracts/checks.js";
import type { AudioManifest } from "../../src/contracts/generated/audio-manifest.js";
import type { SprConfig } from "../../src/contracts/generated/config.js";
import type { NarrationScript, Step } from "../../src/contracts/generated/script.js";
import type { Timeline } from "../../src/contracts/generated/timeline.js";
import { assertContract } from "../../src/contracts/validate.js";
import { ContractError, StageError } from "../../src/lib/errors.js";
import { FakeTtsProvider } from "../../src/providers/tts/fake.js";
import { runTts } from "../../src/tts/speak.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, GOLDEN_SAMPLES, loadGolden } from "../helpers.js";

/** The sample whose hand-written review the outro tests borrow findings from. */
const SAMPLE = GOLDEN_SAMPLES[0] ?? "sample-01-order-outbox";

const HANDLER = "services/orders/src/application/commands/place-order.handler.ts";
const MIGRATION = "services/orders/src/infrastructure/migrations/1700-Add.ts";

/** The shipped defaults with the `video` section adjusted. */
function configWithVideo(overrides: Partial<SprConfig["video"]>): SprConfig {
  const config = defaultConfig();
  return { ...config, video: { ...config.video, ...overrides } };
}

/** A step, with only the fields a test cares about spelled out. */
function step(id: string, kind: Step["kind"], file?: string, lines = [10, 12]): Step {
  return {
    id,
    kind,
    finding_id: kind === "finding" ? "F01" : null,
    text: "Some narration for this step.",
    subtitle: null,
    focus:
      file === undefined
        ? null
        : { file, side: "new", line_start: lines[0] ?? 10, line_end: lines[1] ?? 12 },
  };
}

/** A script plus a manifest whose clips are exactly `durations`, in order. */
function scriptAndManifest(
  steps: Step[],
  durations: number[],
): { script: NarrationScript; manifest: AudioManifest } {
  return {
    script: { schema_version: "1.0", title: "Review: a change", language: "en-US", steps },
    manifest: {
      schema_version: "1.0",
      provider: "fake",
      voice: "af_heart",
      speed: 1,
      sample_rate: 24_000,
      clips: steps.map((s, i) => ({
        step_id: s.id,
        path: `audio/${s.id}.wav`,
        duration_ms: durations[i] ?? 1000,
        cache_key: `key-${s.id}`,
      })),
    },
  };
}

/** The common shape: intro, one finding, wrap-up. */
function simple(durations = [4000, 10_000, 3000], config = defaultConfig()): Timeline {
  const { script, manifest } = scriptAndManifest(
    [step("S00", "intro"), step("S01", "finding", HANDLER), step("S02", "wrap_up")],
    durations,
  );
  return buildTimeline(script, manifest, config);
}

const at = (timeline: Timeline, type: string): number[] =>
  timeline.actions.filter((a) => a.type === type).map((a) => a.at_ms);

describe("buildTimeline windows", () => {
  it("starts at zero and gives each step exactly its clip's length", () => {
    const timeline = simple([4000, 10_000, 3000]);
    expect(timeline.step_windows).toEqual([
      { step_id: "S00", start_ms: 0, end_ms: 4000 },
      { step_id: "S01", start_ms: 4400, end_ms: 14_400 },
      { step_id: "S02", start_ms: 14_800, end_ms: 17_800 },
    ]);
  });

  it("separates every step by exactly gap_ms", () => {
    const timeline = simple([4000, 10_000, 3000], configWithVideo({ gapMs: 1000 }));
    const windows = timeline.step_windows;
    windows.forEach((w, i) => {
      const previous = windows[i - 1];
      if (previous) expect(w.start_ms - previous.end_ms).toBe(1000);
    });
  });

  it("ends one gap after the last word, not on it", () => {
    // Cutting the recording on the last syllable reads as a glitch, and the outro card
    // deserves the same beat that separates every other step.
    const timeline = simple([4000, 10_000, 3000]);
    expect(timeline.total_duration_ms).toBe(17_800 + 400);
  });

  it("refuses a script whose steps have no clip", () => {
    const { script, manifest } = scriptAndManifest(
      [step("S00", "intro"), step("S01", "wrap_up")],
      [1000, 1000],
    );
    const short = { ...manifest, clips: manifest.clips.slice(0, 1) };
    const error = (() => {
      try {
        buildTimeline(script, short, defaultConfig());
      } catch (e: unknown) {
        return e;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(StageError);
    expect((error as StageError).message).toMatch(/No audio clip for step S01/);
    expect((error as StageError).message).toMatch(/spr stage tts/);
  });
});

describe("buildTimeline actions", () => {
  it("frames the video with a title card and an outro", () => {
    const timeline = simple();
    expect(at(timeline, "show_title")).toEqual([0]);
    expect(at(timeline, "hide_title")).toEqual([4000]);
    expect(at(timeline, "show_outro")).toEqual([14_800]);
  });

  it("carries the title in the timeline, so the Recorder need not read the script", () => {
    const title = simple().actions.find((a) => a.type === "show_title");
    expect(title?.text).toBe("Review: a change");
  });

  it("opens, scrolls, highlights and clears for a finding", () => {
    const timeline = simple();
    const forStep = timeline.actions.filter((a) => a.step_id === "S01").map((a) => a.type);
    expect(forStep).toEqual(["open_file", "scroll_to", "highlight", "clear_highlight"]);
  });

  it("points scroll_to and highlight at the step's focus", () => {
    const timeline = simple();
    for (const type of ["scroll_to", "highlight"]) {
      const action = timeline.actions.find((a) => a.type === type);
      expect(action).toMatchObject({ file: HANDLER, side: "new", line_start: 10, line_end: 12 });
    }
    // clear_highlight needs no coordinates; it clears whatever is lit.
    const clear = timeline.actions.find((a) => a.type === "clear_highlight");
    expect(clear?.file).toBeUndefined();
  });

  it("gives every action a step window", () => {
    const timeline = simple();
    const ids = new Set(timeline.step_windows.map((w) => w.step_id));
    for (const action of timeline.actions) expect(ids.has(action.step_id)).toBe(true);
  });

  it("sorts actions by time", () => {
    const timeline = simple();
    const times = timeline.actions.map((a) => a.at_ms);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("the lead-in", () => {
  it("fires 300 ms before the words, in the silence between steps", () => {
    const timeline = simple([4000, 10_000, 3000]);
    // S01 speaks at 4400, so the page is ready at 4100 - inside the 400 ms gap.
    expect(at(timeline, "scroll_to")).toEqual([4100]);
  });

  it("never precedes the previous step's last word, however small the gap", () => {
    // video.gapMs has a minimum of 0. At any gap under 300 an unclamped lead-in slides back
    // inside the previous window, and the page scrolls away from the code while that step is
    // still being spoken. The clamp says what the rule meant: as early as possible without
    // stepping on the step before.
    for (const gapMs of [0, 100, 299]) {
      const timeline = simple([4000, 10_000, 3000], configWithVideo({ gapMs }));
      const previousEnd = timeline.step_windows[0]?.end_ms ?? 0;
      const scrollAt = at(timeline, "scroll_to")[0] ?? -1;

      expect(scrollAt).toBeGreaterThanOrEqual(previousEnd);
      expect(scrollAt).toBe(previousEnd);
    }
  });

  it("never goes negative when a finding is the very first step", () => {
    const { script, manifest } = scriptAndManifest(
      [step("S00", "finding", HANDLER), step("S01", "wrap_up")],
      [5000, 3000],
    );
    const timeline = buildTimeline(script, manifest, defaultConfig());
    expect(at(timeline, "scroll_to")).toEqual([0]);
    for (const action of timeline.actions) expect(action.at_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("open_file", () => {
  it("is skipped while consecutive steps stay in one file", () => {
    const { script, manifest } = scriptAndManifest(
      [
        step("S00", "intro"),
        step("S01", "finding", HANDLER, [10, 12]),
        step("S02", "finding", HANDLER, [30, 31]),
        step("S03", "wrap_up"),
      ],
      [3000, 8000, 8000, 3000],
    );
    const timeline = buildTimeline(script, manifest, defaultConfig());

    expect(timeline.actions.filter((a) => a.type === "open_file")).toHaveLength(1);
    // The second step still scrolls, it just does not re-open a file already on screen.
    expect(at(timeline, "scroll_to")).toHaveLength(2);
  });

  it("is re-emitted when a later step comes back to a file", () => {
    const { script, manifest } = scriptAndManifest(
      [
        step("S00", "intro"),
        step("S01", "finding", HANDLER),
        step("S02", "finding", MIGRATION),
        step("S03", "finding", HANDLER),
        step("S04", "wrap_up"),
      ],
      [3000, 8000, 8000, 8000, 3000],
    );
    const timeline = buildTimeline(script, manifest, defaultConfig());

    expect(timeline.actions.filter((a) => a.type === "open_file").map((a) => a.file)).toEqual([
      HANDLER,
      MIGRATION,
      HANDLER,
    ]);
  });
});

describe("buildTimeline shape", () => {
  it("renders with diff2html and copies the frame from config", () => {
    const timeline = simple([1000, 1000, 1000], configWithVideo({ width: 1920, height: 1080 }));
    expect(timeline.render_mode).toBe("diff2html");
    expect(timeline.video).toEqual({ width: 1920, height: 1080, theme: "dark" });
  });

  it("handles a clean change, which is intro and wrap-up only", () => {
    const { script, manifest } = scriptAndManifest(
      [step("S00", "intro"), step("S01", "wrap_up")],
      [6000, 5000],
    );
    const timeline = buildTimeline(script, manifest, defaultConfig());

    expect(checkTimeline(timeline, manifest)).toEqual([]);
    expect(timeline.actions.map((a) => a.type)).toEqual(["show_title", "hide_title", "show_outro"]);
  });

  it("is deterministic", () => {
    expect(simple()).toEqual(simple());
  });
});

describe("runDirect", () => {
  it("produces a timeline that passes its schema and every cross-file check", () => {
    const { script, manifest } = scriptAndManifest(
      [step("S00", "intro"), step("S01", "finding", HANDLER), step("S02", "wrap_up")],
      [4000, 10_000, 3000],
    );
    const { timeline } = runDirect({ script, manifest, config: defaultConfig() });

    expect(() => {
      assertContract("timeline", timeline);
    }).not.toThrow();
    expect(checkTimeline(timeline, manifest)).toEqual([]);
  });

  it("names the mismatch when the manifest does not voice this script", () => {
    // The useful error is "these two files disagree", not a timeline with silently wrong windows.
    const { script, manifest } = scriptAndManifest(
      [step("S00", "intro"), step("S01", "finding", HANDLER), step("S02", "wrap_up")],
      [4000, 10_000, 3000],
    );
    const stale = { ...manifest, clips: [...manifest.clips].reverse() };
    expect(() => runDirect({ script, manifest: stale, config: defaultConfig() })).toThrow(
      ContractError,
    );
  });

  it("summarizes as steps, actions and a video length", () => {
    const outcome = runDirect({
      ...scriptAndManifest(
        [step("S00", "intro"), step("S01", "finding", HANDLER), step("S02", "wrap_up")],
        [4000, 10_000, 3000],
      ),
      config: defaultConfig(),
    });
    // 2 for the title card, 4 for the finding, 1 for the outro.
    expect(summarizeDirect(outcome)).toBe("timeline: 3 steps, 7 actions, 0:18 of video");
  });
});

describe("every golden script", () => {
  it.each(GOLDEN_SAMPLES)("%s directs into a valid timeline", async (sample) => {
    // Spoken by the fake provider, whose durations are a pure function of word count
    // (ADR-027), so this is deterministic without committing a timeline fixture that would
    // need regenerating whenever the voice or the narration changed.
    const script = loadGolden(sample).script;
    const { manifest } = await runTts({
      script,
      provider: new FakeTtsProvider(),
      config: defaultConfig(),
      runDir: mkdtempSync(path.join(tmpdir(), "spr-direct-")),
    });
    const { timeline } = runDirect({ script, manifest, config: defaultConfig() });

    expect(() => {
      assertContract("timeline", timeline);
    }).not.toThrow();
    expect(checkTimeline(timeline, manifest)).toEqual([]);
    expect(timeline.step_windows).toHaveLength(script.steps.length);
  });
});

describe("summarizeFindings", () => {
  /** A review carrying just the severities a test cares about. */
  function reviewWith(severities: string[]) {
    const { review } = loadGolden(SAMPLE);
    const template = review.findings[0];
    if (template === undefined) throw new Error("the golden review has no findings");
    return {
      ...review,
      findings: severities.map((severity, i) => ({
        ...template,
        id: `F${String(i + 1).padStart(2, "0")}`,
        severity: severity as typeof template.severity,
      })),
    };
  }

  it.each([
    [["high"], "1 issue to fix - 1 high"],
    [["high", "medium"], "2 issues to fix - 1 high, 1 medium"],
    [["low", "low", "critical"], "3 issues to fix - 1 critical, 2 low"],
  ])("%s -> %s", (severities, expected) => {
    expect(summarizeFindings(reviewWith(severities))).toBe(expected);
  });

  it("orders the breakdown by severity, not by the order findings arrive", () => {
    expect(summarizeFindings(reviewWith(["low", "critical", "medium", "high"]))).toBe(
      "4 issues to fix - 1 critical, 1 high, 1 medium, 1 low",
    );
  });

  it("says a clean change is clean, rather than reporting zero of something", () => {
    const { review } = loadGolden(SAMPLE);
    expect(summarizeFindings({ ...review, findings: [] })).toBe("No issues found");
  });
});

describe("the outro card's words", () => {
  it("travel in the show_outro action, so the page needs no other file", () => {
    const { script, manifest } = scriptAndManifest(
      [step("S00", "intro"), step("S01", "finding", HANDLER), step("S02", "wrap_up")],
      [4000, 10_000, 3000],
    );
    const { review } = loadGolden(SAMPLE);
    const { timeline } = runDirect({ script, manifest, review, config: defaultConfig() });

    const outro = timeline.actions.find((a) => a.type === "show_outro");
    expect(outro?.text).toBe(summarizeFindings(review));
  });

  it("are empty rather than missing when no review is given", () => {
    // The schedule itself does not need a review; only the card's line does.
    const { script, manifest } = scriptAndManifest(
      [step("S00", "intro"), step("S01", "wrap_up")],
      [4000, 3000],
    );
    const { timeline } = runDirect({ script, manifest, config: defaultConfig() });
    expect(timeline.actions.find((a) => a.type === "show_outro")?.text).toBe("");
  });
});
