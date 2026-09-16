/**
 * Renders `ingest.json` as the text the Reviewer sees.
 *
 * This is not cosmetic. Given a raw patch, every model in the trial guessed line numbers
 * badly, because new-side numbers are implicit and have to be counted from the `@@` header.
 * Given this rendering, every range they produced passed `HunkIndex.hasRange` (ADR-018).
 * The numbers are already in `ingest.json`, so showing them costs nothing.
 */
import type { IngestResult, KeptFile } from "../contracts/generated/ingest.js";

/** Width of the line-number column; four digits covers any realistic file. */
const NUMBER_WIDTH = 4;

/** Renders one file's header, hunks and lines. Reused by the `get_diff_hunk` tool. */
export function renderFileDiff(file: KeptFile): string {
  return renderFileLines(file).join("\n");
}

function renderFileLines(file: KeptFile): string[] {
  const rename = file.old_path === null ? "" : ` from ${file.old_path}`;
  const out = [`--- file: ${file.path} (${file.status}${rename}) risk ${file.risk_score} ---`];

  if (file.hunks.length === 0) {
    out.push("(no line changes: rename or mode change only)");
    return out;
  }

  for (const hunk of file.hunks) {
    const last = hunk.new_start + hunk.new_lines - 1;
    const range = hunk.new_lines === 0 ? "none (deletion)" : `${hunk.new_start}..${last}`;
    const section = hunk.section === "" ? "" : `  in ${hunk.section}`;
    out.push(`@@ hunk: new lines ${range} @@${section}`);

    for (const line of hunk.lines) {
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      // Deleted lines have no new-side number, so their old number goes in the same column.
      const number = line.new ?? line.old;
      const shown =
        number === null ? " ".repeat(NUMBER_WIDTH) : String(number).padStart(NUMBER_WIDTH);
      out.push(`${shown} ${marker}${line.text}`);
    }
  }
  return out;
}

/**
 * The whole reviewable diff as text. Deterministic: the same `ingest.json` always renders
 * to the same string.
 */
export function renderDiff(ingest: IngestResult): string {
  const out = ingest.files.flatMap((file) => [...renderFileLines(file), ""]);

  if (ingest.skipped.length > 0) {
    // The model should know what it cannot see, so it does not guess about those files.
    out.push("--- not shown ---");
    for (const skipped of ingest.skipped) {
      out.push(`${skipped.file} (${skipped.reason})`);
    }
    out.push("");
  }
  if (ingest.diff.truncated) {
    out.push("Note: the diff was over the size budget, so only the riskiest files are shown.");
    out.push("");
  }

  return out.join("\n").trimEnd();
}
