import { describe, expect, it } from "vitest";
import { buildTimeline } from "../../src/director/timeline.js";
import { runDirect, summarizeDirect } from "../../src/director/direct.js";
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

const HANDLER = "services/orders/src/application/commands/place-order.handler.ts";
const CONSUMER = "services/inventory/src/interface/messaging/order-placed.consumer.ts";
const MIGRATION = "services/orders/src/infrastructure/migrations/1700-Add.ts";

/** The shipped defaults with the `video` section adjusted. */
function configWithVideo(overrides: Partial<SprConfig["video"]>): SprConfig {
  const config = defaultConfig();
  return { ...config, video: { ...config.video, ...overrides } };
}

/** A step, with only the fields a test cares about spelled out. */
function step(id: string, file = HANDLER, lines = [10, 12], findingId = "F01"): Step {
  return {
    id,
    finding_id: findingId,
    text: "Some narration for this step.",
    subtitle: null,
    focus: { file, side: "new", line_start: lines[0] ?? 10, line_end: lines[1] ?? 12 },
  };
}

/** A script plus a manifest whose clips are exactly `durations`, in order. */
function scriptAndManifest(
  steps: Step[],
  durations: number[],
): { script: NarrationScript; manifest: AudioManifest } {
  return {
    script: { schema_version: "1.0", language: "en-US", steps },
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
    [step("S00", HANDLER), step("S01", CONSUMER), step("S02", HANDLER)],
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
    const { script, manifest } = scriptAndManifest([step("S00"), step("S01")], [1000, 1000]);
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
  it("emits nothing but code actions: there are no cards left to show", () => {
    // ADR-042 removed the intro and outro entirely, and the action types with them.
    const types = new Set(simple().actions.map((a) => a.type));
    expect([...types].sort()).toEqual(["clear_highlight", "highlight", "open_file", "scroll_to"]);
  });

  it("starts the first step at zero, with nothing to lead in from", () => {
    // With no intro card in front of it the first step's lead-in clamps to 0, which is why the
    // Recorder positions the page before t0 rather than at it (ADR-042).
    const first = simple().actions.filter((a) => a.step_id === "S00");
    // Everything but the clear, which fires when the step's words end.
    const opening = first.filter((a) => a.type !== "clear_highlight");
    expect(opening.map((a) => a.at_ms)).toEqual([0, 0, 0]);
  });

  it("opens, scrolls, highlights and clears for a finding", () => {
    const timeline = simple();
    const forStep = timeline.actions.filter((a) => a.step_id === "S01").map((a) => a.type);
    expect(forStep).toEqual(["open_file", "scroll_to", "highlight", "clear_highlight"]);
    // And the first step, which has no previous step to lead in from, still gets all four.
    const first = timeline.actions.filter((a) => a.step_id === "S00").map((a) => a.type);
    expect(first).toEqual(["open_file", "scroll_to", "highlight", "clear_highlight"]);
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
    // S00 is the first step and clamps to 0. S01 speaks at 4400, so the page is ready at 4100 -
    // inside the 400 ms gap - and S02 at 14_800 - 300.
    expect(at(timeline, "scroll_to")).toEqual([0, 4100, 14_500]);
  });

  it("never precedes the previous step's last word, however small the gap", () => {
    // video.gapMs has a minimum of 0. At any gap under 300 an unclamped lead-in slides back
    // inside the previous window, and the page scrolls away from the code while that step is
    // still being spoken. The clamp says what the rule meant: as early as possible without
    // stepping on the step before.
    for (const gapMs of [0, 100, 299]) {
      const timeline = simple([4000, 10_000, 3000], configWithVideo({ gapMs }));
      const previousEnd = timeline.step_windows[0]?.end_ms ?? 0;
      // The first step's own lead-in is 0; the one that matters is the second step's.
      const scrollAt = at(timeline, "scroll_to")[1] ?? -1;

      expect(scrollAt).toBeGreaterThanOrEqual(previousEnd);
      expect(scrollAt).toBe(previousEnd);
    }
  });

  it("never goes negative, since every video now opens on a finding", () => {
    const { script, manifest } = scriptAndManifest([step("S00", HANDLER)], [5000]);
    const timeline = buildTimeline(script, manifest, defaultConfig());
    expect(at(timeline, "scroll_to")).toEqual([0]);
    for (const action of timeline.actions) expect(action.at_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("open_file", () => {
  it("is skipped while consecutive steps stay in one file", () => {
    const { script, manifest } = scriptAndManifest(
      [step("S00", HANDLER, [10, 12]), step("S01", HANDLER, [30, 31])],
      [8000, 8000],
    );
    const timeline = buildTimeline(script, manifest, defaultConfig());

    expect(timeline.actions.filter((a) => a.type === "open_file")).toHaveLength(1);
    // The second step still scrolls, it just does not re-open a file already on screen.
    expect(at(timeline, "scroll_to")).toHaveLength(2);
  });

  it("is re-emitted when a later step comes back to a file", () => {
    const { script, manifest } = scriptAndManifest(
      [
        step("S00"),
        step("S01", HANDLER),
        step("S02", MIGRATION),
        step("S03", HANDLER),
        step("S04"),
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

  it("handles a single-finding change, which is a whole video", () => {
    const { script, manifest } = scriptAndManifest([step("S00")], [6000]);
    const timeline = buildTimeline(script, manifest, defaultConfig());

    expect(checkTimeline(timeline, manifest)).toEqual([]);
    expect(timeline.actions.map((a) => a.type)).toEqual([
      "open_file",
      "scroll_to",
      "highlight",
      "clear_highlight",
    ]);
  });

  it("is deterministic", () => {
    expect(simple()).toEqual(simple());
  });
});

describe("runDirect", () => {
  it("produces a timeline that passes its schema and every cross-file check", () => {
    const { script, manifest } = scriptAndManifest(
      [step("S00"), step("S01", HANDLER), step("S02")],
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
      [step("S00"), step("S01", HANDLER), step("S02")],
      [4000, 10_000, 3000],
    );
    const stale = { ...manifest, clips: [...manifest.clips].reverse() };
    expect(() => runDirect({ script, manifest: stale, config: defaultConfig() })).toThrow(
      ContractError,
    );
  });

  it("summarizes as steps, actions and a video length", () => {
    const outcome = runDirect({
      ...scriptAndManifest([step("S00"), step("S01", HANDLER), step("S02")], [4000, 10_000, 3000]),
      config: defaultConfig(),
    });
    // Four per finding: open, scroll, highlight, clear - and the second step reuses the file.
    expect(summarizeDirect(outcome)).toBe("timeline: 3 steps, 10 actions, 0:18 of video");
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
