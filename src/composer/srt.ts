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

/** How much text one cue can hold: two lines of forty-two characters. */
const CUE_CHARS = MAX_LINE_CHARS * MAX_LINES;

/**
 * Splits words into exactly `count` cues, filling each to its share of what is left.
 *
 * Recomputing the target from the *remaining* text rather than dividing once means a long word
 * that overshoots one cue is absorbed by the rest instead of pushing the whole remainder into
 * the last one.
 */
function splitEvenly(words: readonly string[], count: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let remaining = words.join(" ").length;

  for (const word of words) {
    const held = current.join(" ").length;
    const target = remaining / (count - groups.length);
    // The last cue takes whatever is left: `count` cues must come back, no more and no fewer.
    const full = current.length > 0 && held + 1 + word.length > target;
    if (full && groups.length < count - 1) {
      groups.push(current);
      remaining -= held + 1;
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Splits one step's words into cues of at most two lines, and divides its window between them
 * in proportion to how much text each one carries.
 *
 * **The cue count comes from the text's length, not from where greedy wrapping happens to
 * stop.** Filling lines to the margin and then pairing them leaves whatever does not divide by
 * two in a trailing cue of its own, and proportional timing then gives that cue a proportional
 * share of nothing: `layer.` held the screen for 415 ms on `sample-01` (ADR-034, ADR-040). So
 * the count is decided first and the words are spread across it, which leaves no remainder to
 * be lopsided about. A group needing three lines widens the count by one and the split runs
 * again, so the two-line ceiling still holds.
 *
 * The last cue is made to end exactly on the window's end rather than wherever the rounding
 * lands. Cues that stop a few milliseconds early would be invisible; a final cue that overran
 * its window would collide with the next step's first one.
 */
export function cuesForStep(text: string, startMs: number, endMs: number): Cue[] {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return [];

  let count = Math.max(1, Math.ceil(text.trim().length / CUE_CHARS));
  let groups = splitEvenly(words, count);
  // A cue that still needs three lines gets another cue to share with. Bounded by the word
  // count: one word per cue always wraps to a single line, whatever `wrapLines` does with it.
  while (groups.some((g) => wrapLines(g.join(" ")).length > MAX_LINES) && count < words.length) {
    count += 1;
    groups = splitEvenly(words, count);
  }

  const weights = groups.map((g) => g.join(" ").length);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const span = endMs - startMs;

  const cues: Cue[] = [];
  let at = startMs;
  groups.forEach((group, i) => {
    const last = i === groups.length - 1;
    const end = last ? endMs : at + Math.round((span * (weights[i] ?? 0)) / (total || 1));
    // `splitEvenly` hands back words; wrapping is still what decides where a line breaks.
    cues.push({ start_ms: at, end_ms: end, lines: wrapLines(group.join(" ")) });
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
