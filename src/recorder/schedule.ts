/**
 * When the Recorder fires each action, and how long it waits.
 *
 * Pure, and that is the point: almost everything that can go wrong about timing is arithmetic
 * over a timeline, and arithmetic can be tested without launching a browser. `record.ts` is
 * left as a thin driver around this.
 *
 * The rule that matters is in `waitFor`: every wait is computed from a single origin, never
 * chained. Sleeping "the gap between this action and the last one" over and over accumulates
 * every scheduler overshoot, and across a five-minute video the last highlight lands seconds
 * after the words about it.
 */
import type { Timeline } from "../contracts/generated/timeline.js";

/** One action, with the time it is due relative to the timeline's own zero. */
export type ScheduledAction = Timeline["actions"][number];

/**
 * How long to wait before an action is due.
 *
 * @param action the action about to be run.
 * @param elapsedMs how long since the timeline started, from a monotonic clock.
 * @returns milliseconds to sleep, never negative - an action that is already late runs now.
 *
 * Returning 0 rather than a negative number is what absorbs a slow step instead of
 * compounding it: if one action overran, the next ones fire immediately until the schedule has
 * caught up, and the video stays in step with the audio from then on.
 */
export function waitFor(action: ScheduledAction, elapsedMs: number): number {
  return Math.max(0, action.at_ms - elapsedMs);
}

/**
 * How long to hold the recording open after the last action, so the video covers the whole
 * timeline rather than stopping on the final cue.
 *
 * @returns milliseconds to sleep, never negative.
 */
export function tailFor(timeline: Timeline, elapsedMs: number): number {
  return Math.max(0, timeline.total_duration_ms - elapsedMs);
}

/**
 * The actions in the order they must be executed.
 *
 * The Director already sorts by `at_ms` and `checkTimeline` enforces it, so this is a copy
 * rather than a re-sort: re-sorting here could reorder actions that share a timestamp, and at
 * `gapMs: 0` one step's `clear_highlight` and the next step's `open_file` do exactly that.
 * The Director's order is the intended one and is preserved.
 */
export function actionsOf(timeline: Timeline): ScheduledAction[] {
  return [...timeline.actions];
}

/**
 * Whether an action is one whose effect can be checked on the live page.
 *
 * Used by the recorder's own test: after a `highlight` fires, the number of lit rows should
 * match the range it asked for. That is the assertion that catches a timeline firing the wrong
 * action or a selector that stopped matching - our bugs, rather than the browser's.
 */
export function highlightRowCount(action: ScheduledAction): number | undefined {
  if (action.type !== "highlight") return undefined;
  if (action.line_start === undefined || action.line_end === undefined) return undefined;
  return action.line_end - action.line_start + 1;
}
