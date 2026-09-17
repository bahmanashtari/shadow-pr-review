/**
 * Subtitles, as pure arithmetic over text and time.
 *
 * CLAUDE.md names this alongside the Director as something to keep free of I/O, and the reason
 * shows up in the tests: splitting a paragraph into readable cues and dividing a step's window
 * between them is fiddly, easy to get subtly wrong, and needs no ffmpeg to check.
 *
 * Timing comes from the timeline's `step_windows` - which are measured audio (ADR-027) - and
 * the words come from the script. A step's `subtitle` wins over its `text` when it is set,
 * because that is exactly what the schema has it for.
 */
import type { NarrationScript } from "../contracts/generated/script.js";
import type { Timeline } from "../contracts/generated/timeline.js";

/** About as much as fits comfortably across a 1280-wide frame at subtitle size. */
const MAX_LINE_CHARS = 42;

/** Two lines is the convention; three starts covering the code being discussed. */
const MAX_LINES = 2;

/** One subtitle cue: when it shows, and the lines it shows. */
export interface Cue {
  start_ms: number;
  end_ms: number;
  lines: string[];
}

/**
 * Wraps text to a line width without ever breaking a word.
 *
 * A word longer than the limit gets a line of its own rather than being cut: a hyphenated
 * identifier read aloud is rare, but splitting one across lines would be unreadable.
 */
export function wrapLines(text: string, maxChars = MAX_LINE_CHARS): string[] {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length <= maxChars || line === "") {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * Splits one step's words into cues of at most two lines, and divides its window between them
 * in proportion to how much text each one carries.
 *
 * The last cue is made to end exactly on the window's end rather than wherever the rounding
 * lands. Cues that stop a few milliseconds early would be invisible; a final cue that overran
 * its window would collide with the next step's first one.
 */
export function cuesForStep(text: string, startMs: number, endMs: number): Cue[] {
  const lines = wrapLines(text);
  if (lines.length === 0) return [];

  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += MAX_LINES) groups.push(lines.slice(i, i + MAX_LINES));

  const weights = groups.map((g) => g.join(" ").length);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const span = endMs - startMs;

  const cues: Cue[] = [];
  let at = startMs;
  groups.forEach((group, i) => {
    const last = i === groups.length - 1;
    const end = last ? endMs : at + Math.round((span * (weights[i] ?? 0)) / (total || 1));
    cues.push({ start_ms: at, end_ms: end, lines: group });
    at = end;
  });
  return cues;
}

/** `HH:MM:SS,mmm` - SRT uses a comma for the decimal, not a point. */
export function timestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  const hours = pad(Math.floor(clamped / 3_600_000), 2);
  const minutes = pad(Math.floor(clamped / 60_000) % 60, 2);
  const seconds = pad(Math.floor(clamped / 1000) % 60, 2);
  return `${hours}:${minutes}:${seconds},${pad(clamped % 1000, 3)}`;
}

/** Every cue for a whole script, in order. */
export function cuesFor(timeline: Timeline, script: NarrationScript): Cue[] {
  const words = new Map(script.steps.map((s) => [s.id, s.subtitle ?? s.text]));
  return timeline.step_windows.flatMap((window) => {
    const text = words.get(window.step_id);
    return text === undefined ? [] : cuesForStep(text, window.start_ms, window.end_ms);
  });
}

/**
 * The contents of `subtitles.srt`.
 *
 * Cues are numbered from 1, blocks are separated by a blank line, and the file ends with one -
 * which some players require and none mind.
 */
export function buildSrt(timeline: Timeline, script: NarrationScript): string {
  return cuesFor(timeline, script)
    .map((cue, i) =>
      [
        `${i + 1}`,
        `${timestamp(cue.start_ms)} --> ${timestamp(cue.end_ms)}`,
        ...cue.lines,
        "",
      ].join("\n"),
    )
    .join("\n");
}
