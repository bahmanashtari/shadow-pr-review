/**
 * The Director's arithmetic: measured audio becomes a schedule.
 *
 * Pure, and deliberately so (CLAUDE.md: "Pure functions for the Director and SRT generation;
 * unit test them without I/O"). Nothing here is a judgement call, so nothing here is a model -
 * and nothing here touches a file, so every edge is testable in memory.
 *
 * It reads `script.json` and `audio/manifest.json` and nothing else. `focus` on a step was
 * copied from a finding the Verifier already grounded against the diff, so re-checking those
 * line numbers here would re-prove an upstream proof and make this function depend on a third
 * file for nothing.
 */
import type { AudioManifest } from "../contracts/generated/audio-manifest.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { NarrationScript, Step } from "../contracts/generated/script.js";
import type { Timeline } from "../contracts/generated/timeline.js";
import { StageError } from "../lib/errors.js";

/** How early the page opens and scrolls to the code, before the words about it start. */
const LEAD_IN_MS = 300;

/** The page the Recorder renders. ADR-005: a local diff2html page, not the GitHub UI. */
const RENDER_MODE = "diff2html" as const;

type Action = Timeline["actions"][number];
type StepWindow = Timeline["step_windows"][number];

/**
 * When each step's audio plays: back to back, one `gap_ms` of silence between them.
 *
 * `checkTimeline` enforces this same relation from the outside, so this is the one place the
 * numbers are produced and the contract is what proves them right.
 */
function windowsOf(script: NarrationScript, durations: Map<string, number>, gapMs: number) {
  const windows: StepWindow[] = [];
  let start = 0;

  for (const step of script.steps) {
    const duration = durations.get(step.id);
    if (duration === undefined) {
      throw new StageError(
        "direct",
        `No audio clip for step ${step.id}. Re-run \`spr stage tts\` so the manifest matches ` +
          `this script.`,
      );
    }
    windows.push({ step_id: step.id, start_ms: start, end_ms: start + duration });
    start = start + duration + gapMs;
  }
  return windows;
}

/**
 * When a step's lead-in fires: 300 ms before it speaks, but never before the previous step has
 * finished speaking.
 *
 * The second clamp is the one worth explaining. ARCHITECTURE only says "clamped", meaning
 * clamped to zero, and at the default `gapMs` of 400 that is all it ever needs. But
 * `video.gapMs` has a minimum of 0, and at any gap under 300 the lead-in slides back inside the
 * previous step's window - so the page would scroll away from the code while that step's
 * narration is still being spoken. Clamping to the previous end says what the rule always
 * meant: as early as possible without stepping on the step before.
 */
function leadInOf(window: StepWindow, previousEnd: number): number {
  return Math.max(0, previousEnd, window.start_ms - LEAD_IN_MS);
}

/** Where on screen a finding step looks. `checkScript` guarantees a finding step has one. */
function focusOf(step: Step): NonNullable<Step["focus"]> {
  if (step.focus === null) {
    throw new StageError("direct", `Step ${step.id} narrates a finding but has no focus.`);
  }
  return step.focus;
}

/** What {@link actionsFor} needs to know that is not on the step itself. */
interface StepContext {
  window: StepWindow;
  /** End of the previous step's window, which the lead-in may not precede. */
  previousEnd: number;
  /** File the page is already showing, so it is not re-opened. */
  openFile: string | undefined;
  /** The title card's words. */
  title: string;
  /** The outro card's words. */
  outro: string;
}

/** The actions for one step, in the order they fire. */
function actionsFor(step: Step, context: StepContext): Action[] {
  const { window, previousEnd, openFile, title } = context;

  if (step.kind === "intro") {
    return [
      // The title travels in the timeline, so the Recorder never has to read script.json.
      { at_ms: window.start_ms, step_id: step.id, type: "show_title", text: title },
      { at_ms: window.end_ms, step_id: step.id, type: "hide_title" },
    ];
  }
  if (step.kind === "wrap_up") {
    return [{ at_ms: window.start_ms, step_id: step.id, type: "show_outro", text: context.outro }];
  }

  const focus = focusOf(step);
  const at = leadInOf(window, previousEnd);
  const where = {
    file: focus.file,
    side: focus.side,
    line_start: focus.line_start,
    line_end: focus.line_end,
  };

  return [
    // Consecutive steps in one file do not re-open it; the page is already showing it.
    ...(focus.file === openFile
      ? []
      : [{ at_ms: at, step_id: step.id, type: "open_file" as const, file: focus.file }]),
    { at_ms: at, step_id: step.id, type: "scroll_to", ...where },
    { at_ms: window.start_ms, step_id: step.id, type: "highlight", ...where },
    { at_ms: window.end_ms, step_id: step.id, type: "clear_highlight" },
  ];
}

/**
 * Builds the timeline for a spoken script.
 *
 * @param script the narration, which supplies the order, the kinds and the focus.
 * @param manifest the measured clips, which supply every duration (ADR-027).
 * @param config `video.gapMs` and the frame size.
 * @param options the outro card's words, when the stage has worked them out.
 */
export interface BuildTimelineOptions {
  /**
   * The outro card's words. A string rather than a review, so this stays a pure function of
   * the script and the measured audio: the stage above works out what to say (plan m2-step3).
   */
  outroText?: string;
}

export function buildTimeline(
  script: NarrationScript,
  manifest: AudioManifest,
  config: SprConfig,
  options: BuildTimelineOptions = {},
): Timeline {
  const gapMs = config.video.gapMs;
  const durations = new Map(manifest.clips.map((clip) => [clip.step_id, clip.duration_ms]));
  const windows = windowsOf(script, durations, gapMs);

  const actions: Action[] = [];
  let openFile: string | undefined;

  script.steps.forEach((step, i) => {
    const window = windows[i];
    if (window === undefined) return;

    for (const action of actionsFor(step, {
      window,
      previousEnd: windows[i - 1]?.end_ms ?? 0,
      openFile,
      title: script.title,
      outro: options.outroText ?? "",
    })) {
      if (action.type === "open_file") openFile = action.file;
      actions.push(action);
    }
  });

  // Emitted in step order, then sorted by time. Array.prototype.sort is stable, which matters:
  // at a gap of 0 one step's clear_highlight and the next step's open_file share a timestamp,
  // and the Recorder must run them in the order they were emitted rather than an arbitrary one.
  actions.sort((a, b) => a.at_ms - b.at_ms);

  const lastEnd = windows.at(-1)?.end_ms ?? 0;

  return {
    schema_version: "1.0",
    render_mode: RENDER_MODE,
    video: {
      width: config.video.width,
      height: config.video.height,
      theme: config.video.theme,
    },
    gap_ms: gapMs,
    // One gap of tail. Cutting the recording on the last syllable reads as a glitch, and the
    // outro card deserves the same beat that separates every other step.
    total_duration_ms: lastEnd + gapMs,
    step_windows: windows,
    actions,
  };
}
