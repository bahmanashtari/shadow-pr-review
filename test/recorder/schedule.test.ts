import { describe, expect, it } from "vitest";
import {
  actionsOf,
  highlightRowCount,
  tailFor,
  waitFor,
  type ScheduledAction,
} from "../../src/recorder/schedule.js";
import type { Timeline } from "../../src/contracts/generated/timeline.js";

function action(at_ms: number, type: ScheduledAction["type"] = "highlight"): ScheduledAction {
  return { at_ms, step_id: "S01", type };
}

function timeline(actions: ScheduledAction[], total = 10_000): Timeline {
  return {
    schema_version: "1.0",
    render_mode: "diff2html",
    video: { width: 1280, height: 720, theme: "dark" },
    gap_ms: 400,
    total_duration_ms: total,
    step_windows: [{ step_id: "S01", start_ms: 0, end_ms: total }],
    actions,
  };
}

describe("waitFor", () => {
  it("waits the remaining time until an action is due", () => {
    expect(waitFor(action(5000), 1200)).toBe(3800);
  });

  it("fires immediately when the action is already due", () => {
    expect(waitFor(action(5000), 5000)).toBe(0);
  });

  it("never waits a negative time when a previous step overran", () => {
    // Absorbing the overrun rather than compounding it: the schedule catches up and everything
    // after stays in step with the audio.
    expect(waitFor(action(5000), 7300)).toBe(0);
  });

  it("measures from one origin, so overshoot does not accumulate", () => {
    // The trap this avoids: sleeping "the gap since the last action" over and over adds every
    // scheduler overshoot together, and across a five-minute video the last cue lands late.
    const cues = [1000, 2000, 3000, 4000];
    // Every sleep is late by 50 ms, but each wait is recomputed against the true elapsed time.
    let elapsed = 0;
    const waits = cues.map((at) => {
      const wait = waitFor(action(at), elapsed);
      elapsed += wait + 50;
      return wait;
    });
    expect(waits).toEqual([1000, 950, 950, 950]);
    // Four actions, 150 ms of accumulated overshoot - not 4 x 50 compounding into the schedule.
    expect(elapsed).toBe(4050);
  });
});

describe("tailFor", () => {
  it("holds the recording open to the end of the timeline", () => {
    expect(tailFor(timeline([], 57_000), 56_000)).toBe(1000);
  });

  it("does not wait when the timeline has already been covered", () => {
    expect(tailFor(timeline([], 57_000), 57_400)).toBe(0);
  });
});

describe("actionsOf", () => {
  it("keeps the Director's order, including for actions sharing a timestamp", () => {
    // Re-sorting here would be wrong: at gapMs 0 one step's clear_highlight and the next
    // step's open_file share an at_ms, and the Director's order is the intended one.
    const shared: ScheduledAction[] = [
      { at_ms: 4000, step_id: "S01", type: "clear_highlight" },
      { at_ms: 4000, step_id: "S02", type: "open_file", file: "a.ts" },
      { at_ms: 4000, step_id: "S02", type: "scroll_to", file: "a.ts" },
    ];
    expect(actionsOf(timeline(shared)).map((a) => a.type)).toEqual([
      "clear_highlight",
      "open_file",
      "scroll_to",
    ]);
  });

  it("copies rather than aliasing, so the timeline is not mutated", () => {
    const source = timeline([action(1), action(2)]);
    const copy = actionsOf(source);
    copy.pop();
    expect(source.actions).toHaveLength(2);
  });

  it("handles a timeline with no actions", () => {
    expect(actionsOf(timeline([]))).toEqual([]);
  });
});

describe("highlightRowCount", () => {
  it("counts the rows a highlight should light, inclusive of both ends", () => {
    const lit: ScheduledAction = {
      at_ms: 0,
      step_id: "S01",
      type: "highlight",
      file: "a.ts",
      side: "new",
      line_start: 19,
      line_end: 27,
    };
    expect(highlightRowCount(lit)).toBe(9);
  });

  it("counts a single-line highlight as one row", () => {
    expect(
      highlightRowCount({
        at_ms: 0,
        step_id: "S01",
        type: "highlight",
        file: "a.ts",
        side: "new",
        line_start: 22,
        line_end: 22,
      }),
    ).toBe(1);
  });

  it("is undefined for actions that light nothing", () => {
    expect(highlightRowCount(action(0, "open_file"))).toBeUndefined();
    expect(highlightRowCount(action(0, "clear_highlight"))).toBeUndefined();
    // A highlight without a range cannot be checked, and must not be guessed at.
    expect(highlightRowCount(action(0, "highlight"))).toBeUndefined();
  });
});
