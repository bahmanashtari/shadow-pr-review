/**
 * The read API every later stage uses to ask questions about the reviewed diff
 * (ADR-014). The Verifier, Director and Recorder never re-parse the patch.
 */
import type { IngestResult, KeptFile } from "../contracts/generated/ingest.js";

/** Which side of the diff a line number refers to. */
export type DiffSide = "old" | "new";

interface FileIndex {
  file: KeptFile;
  old: Map<number, string>;
  new: Map<number, string>;
  /** Normalized text of every diff line, grouped by hunk, in diff order. */
  hunkTexts: string[][];
}

/**
 * A diff line as the Reviewer is shown it: the line number, a `+`, `-` or space marker, then
 * the code. Models are asked to copy only the code, but sometimes copy the whole line.
 *
 * The space marker is a context line - unchanged code around a change. Every golden diff added
 * whole files until sample-06, so no context line could be quoted and only `+` and `-` were
 * recognised; the first modified-file sample lost a finding quoted as `3 import {...}`.
 */
const RENDERED_LINE = /^(\d+)(?:\s*[+-]\s?|\s+)(.*)$/;

/** Trims and collapses runs of spaces and tabs, so indentation never breaks a match. */
export function normalizeSnippet(text: string): string {
  return text.replace(/[ \t]+/g, " ").trim();
}

function indexFile(file: KeptFile): FileIndex {
  const index: FileIndex = { file, old: new Map(), new: new Map(), hunkTexts: [] };
  for (const hunk of file.hunks) {
    const texts: string[] = [];
    for (const line of hunk.lines) {
      if (line.old !== null) index.old.set(line.old, line.text);
      if (line.new !== null) index.new.set(line.new, line.text);
      texts.push(normalizeSnippet(line.text));
    }
    index.hunkTexts.push(texts);
  }
  return index;
}

/** Answers "does this file, line or snippet exist in the diff?" for one ingest result. */
export class HunkIndex {
  private constructor(private readonly byPath: ReadonlyMap<string, FileIndex>) {}

  /** Builds an index over the kept files of an `ingest.json`. */
  static fromIngest(ingest: IngestResult): HunkIndex {
    return new HunkIndex(new Map(ingest.files.map((file) => [file.path, indexFile(file)])));
  }

  /** True when the diff contains this file. */
  hasFile(path: string): boolean {
    return this.byPath.has(path);
  }

  /** The kept file entry, or undefined when the diff does not contain it. */
  file(path: string): KeptFile | undefined {
    return this.byPath.get(path)?.file;
  }

  /** Every kept file, in diff order. */
  files(): KeptFile[] {
    return [...this.byPath.values()].map((entry) => entry.file);
  }

  /**
   * True only when every line from `start` to `end` appears on `side` of this file's diff.
   * A finding that points outside the diff cannot be highlighted, so it is dropped.
   */
  hasRange(path: string, side: DiffSide, start: number, end: number): boolean {
    const entry = this.byPath.get(path);
    if (!entry) return false;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 1 || end < start) return false;
    const lines = side === "old" ? entry.old : entry.new;
    for (let line = start; line <= end; line += 1) {
      if (!lines.has(line)) return false;
    }
    return true;
  }

  /** The text of one line, without its `+`, `-` or space marker. */
  lineText(path: string, side: DiffSide, line: number): string | undefined {
    const entry = this.byPath.get(path);
    if (!entry) return undefined;
    return (side === "old" ? entry.old : entry.new).get(line);
  }

  /**
   * True when `snippet` appears in this file's diff lines, ignoring indentation and runs of
   * spaces. A multi-line snippet must match consecutive lines of a single hunk.
   * This is how the Verifier proves a finding quotes real code.
   */
  containsSnippet(path: string, snippet: string): boolean {
    const entry = this.byPath.get(path);
    if (!entry) return false;
    const parts = snippet.split("\n").map(normalizeSnippet);
    if (parts.length === 0 || parts.every((p) => p === "")) return false;
    if (matchesConsecutive(entry, parts)) return true;

    const peeled = parts.map((part) => peelRenderedPrefix(entry, part));
    if (!peeled.includes(null) && matchesConsecutive(entry, peeled as string[])) return true;

    // Last, a single quote whose line breaks were replaced by a space or by nothing.
    const [only] = parts;
    return parts.length === 1 && only !== undefined && matchesAcrossLines(entry, only);
  }
}

/**
 * What a quote says once a copied `12 +` prefix is taken off, without checking that line 12
 * backs it up. Empty for a quote of a blank line, which grounds nothing: Verify skips such a
 * quote rather than dropping the finding that carries it (ADR-046).
 */
export function quotedText(snippet: string): string {
  const normalized = normalizeSnippet(snippet);
  const match = RENDERED_LINE.exec(normalized);
  return match ? normalizeSnippet(match[2] ?? "") : normalized;
}

/** The longest run of lines one quote may span; the case that set it spanned seven. */
const MAX_SPAN = 12;

/** Removes every space, tab and line break. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * True when a one-line quote is really several consecutive lines of one hunk joined together.
 *
 * Models copy a multi-line statement - a SQL template literal, typically - as one line, joining
 * the lines with a space or with nothing (sample-05 has both in one quote). Compared with all
 * whitespace removed, every other character must still be in the diff, in order, so a paraphrase
 * or an invented line still fails; this is ADR-020's move for a second citation habit. The match
 * must start in the window's first line and end in its last, so it genuinely spans rather than
 * sitting inside one line that the single-line check would already have found.
 */
function matchesAcrossLines(entry: FileIndex, snippet: string): boolean {
  const target = squeeze(snippet);
  if (target === "") return false;

  return entry.hunkTexts.some((texts) => {
    for (let start = 0; start < texts.length; start += 1) {
      const first = squeeze(texts[start] ?? "");
      if (first === "") continue;
      let joined = first;
      for (let end = start + 1; end < texts.length && end < start + MAX_SPAN; end += 1) {
        const last = squeeze(texts[end] ?? "");
        joined += last;
        if (last === "") continue;
        const lastBegins = joined.length - last.length;
        for (let at = joined.indexOf(target); at !== -1 && at < first.length;) {
          if (at + target.length > lastBegins) return true;
          at = joined.indexOf(target, at + 1);
        }
      }
    }
    return false;
  });
}

/** True when `parts` match consecutive diff lines inside one hunk. */
function matchesConsecutive(entry: FileIndex, parts: readonly string[]): boolean {
  return entry.hunkTexts.some((texts) => {
    const last = texts.length - parts.length;
    for (let start = 0; start <= last; start += 1) {
      if (parts.every((part, offset) => (texts[start + offset] ?? "").includes(part))) return true;
    }
    return false;
  });
}

/**
 * Removes a copied `12 + code` prefix, but only when line 12 of this file really contains
 * that code. Returns the part unchanged when it carries no such prefix, or null when the
 * claimed line number does not back it up.
 */
function peelRenderedPrefix(entry: FileIndex, part: string): string | null {
  const match = RENDERED_LINE.exec(part);
  if (!match) return part;
  const text = normalizeSnippet(match[2] ?? "");
  if (text === "") return null;
  const line = Number(match[1]);
  const onSide = (side: ReadonlyMap<number, string>): boolean => {
    const actual = side.get(line);
    return actual !== undefined && normalizeSnippet(actual).includes(text);
  };
  return onSide(entry.new) || onSide(entry.old) ? text : null;
}
