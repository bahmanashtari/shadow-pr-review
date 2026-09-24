/**
 * The changed files as they are at the head revision, shown to a Reviewer that has a checkout
 * (roadmap step 21, ADR-061).
 *
 * Offering the code was not enough. With `read_file` reachable and an instruction to read before
 * asserting, the default model still asserted what a method the hunk cuts off does, and whether a
 * property declared above the first hunk may hold null - both in the file the change itself
 * touched, and both wrong (ADR-060). So the code goes in front of it instead of behind a tool.
 *
 * The content is as untrusted as the diff, so it belongs in the `user` message, never the system
 * prompt (ADR-049). Findings still cite the diff: evidence is checked against the diff (ADR-019),
 * and a finding on unchanged lines is still out of scope (ADR-047).
 */
import { readFileSync } from "node:fs";
import type { IngestResult } from "../contracts/generated/ingest.js";
import { resolveInsideRepo } from "./tools/review-tools.js";

/**
 * Bytes one file may take, line numbers included. About 5,000 tokens: a 480-line service file
 * fits whole, and a long test file is cut rather than crowding out the code it tests.
 */
export const HEAD_FILE_MAX_BYTES = 20_000;

/**
 * Bytes every file together may take, about 9,000 tokens. The model is given a 32,768-token
 * context, and the system prompt, the diff and its thinking have to fit beside this.
 */
export const HEAD_FILES_MAX_BYTES = 32_000;

/** Caps, overridable so tests can exercise them without large fixtures. */
export interface HeadFilesOptions {
  perFileBytes?: number;
  totalBytes?: number;
}

/** Width of the line-number column, the same as the diff's. */
const NUMBER_WIDTH = 4;

/** One file's lines, numbered, or why it could not be read. */
interface HeadFile {
  path: string;
  rows: string[];
  bytes: number;
  unreadable: boolean;
}

function readHead(repoRoot: string, filePath: string): HeadFile {
  try {
    const text = readFileSync(resolveInsideRepo(repoRoot, filePath), "utf8");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const rows = lines.map((line, i) => `${String(i + 1).padStart(NUMBER_WIDTH)}  ${line}`);
    const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row) + 1, 0);
    return { path: filePath, rows, bytes, unreadable: false };
  } catch {
    // A path that escapes the checkout, a directory, a binary that is not UTF-8: say it, skip it.
    return { path: filePath, rows: [], bytes: 0, unreadable: true };
  }
}

/** The leading rows that fit in `cap` bytes. */
function fit(rows: readonly string[], cap: number): { rows: string[]; bytes: number } {
  const kept: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(row) + 1;
    if (bytes + size > cap) break;
    kept.push(row);
    bytes += size;
  }
  return { rows: kept, bytes };
}

/**
 * Renders every added, modified or renamed file at the head revision, capped per file and in
 * total. The smaller files are given their share first, so a large file is the one cut, and it is
 * cut at a line boundary with a note saying where. Deleted files have no head revision.
 *
 * @returns the block to put after the diff, or an empty string when there is nothing to show.
 */
export function renderHeadFiles(
  ingest: IngestResult,
  repoRoot: string,
  options: HeadFilesOptions = {},
): string {
  const perFile = options.perFileBytes ?? HEAD_FILE_MAX_BYTES;
  const files = ingest.files
    .filter((f) => f.status !== "deleted")
    .map((f) => readHead(repoRoot, f.path));
  if (files.length === 0) return "";

  // Allocate smallest first, render in the diff's order.
  const shown = new Map<string, { rows: string[] }>();
  let remaining = options.totalBytes ?? HEAD_FILES_MAX_BYTES;
  for (const file of [...files].sort((a, b) => a.bytes - b.bytes)) {
    if (file.unreadable) continue;
    const kept = fit(file.rows, Math.min(perFile, remaining));
    remaining -= kept.bytes;
    shown.set(file.path, kept);
  }

  const out = [
    "The changed files as they are at the head revision, for reading only. Findings cite the " +
      "diff above, never these lines: use them to see what the code around a change does.",
  ];
  for (const file of files) {
    const kept = shown.get(file.path);
    if (file.unreadable || kept === undefined) {
      out.push("", `--- whole file at head: ${file.path} (could not be read) ---`);
      continue;
    }
    const total = file.rows.length;
    if (kept.rows.length === 0) {
      out.push(
        "",
        `--- whole file at head: ${file.path} (${total} lines, over the size budget) ---`,
      );
      continue;
    }
    const cut = kept.rows.length < total ? `, cut after line ${kept.rows.length}` : "";
    out.push("", `--- whole file at head: ${file.path} (${total} lines${cut}) ---`, ...kept.rows);
  }
  return out.join("\n");
}
