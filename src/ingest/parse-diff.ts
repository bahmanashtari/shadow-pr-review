/**
 * A small parser for git-format unified diffs (ADR-014: no diff-parsing dependency).
 * It keeps each file's block of the input verbatim so `diff.patch` can be rebuilt by
 * concatenating the blocks of the kept files.
 */
import type { FileStatus, Hunk, Line } from "../contracts/generated/ingest.js";
import { StageError } from "../lib/errors.js";

/** One file's entry in a parsed diff. */
export interface ParsedFile {
  /** Path on the new side; the old path for deleted files. */
  path: string;
  /** Previous path for renamed or copied files; otherwise null. */
  old_path: string | null;
  status: FileStatus;
  /** True for `Binary files ... differ` and `GIT binary patch`; such files have no hunks. */
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  /** This file's lines of the input diff, verbatim, always ending with a newline. */
  raw: string;
  /** Byte length of `raw` in UTF-8. */
  bytes: number;
}

/** The mail-style signature separator that ends `git format-patch` output. */
const SIGNATURE = "-- ";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

function fail(message: string): never {
  throw new StageError("ingest", message);
}

/** Removes one trailing carriage return, so CRLF diffs parse like LF ones. */
function withoutCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Decodes git's C-style quoting, for example `"a/caf\303\251 \"x\".ts"`.
 * Octal escapes are collected as bytes and decoded as UTF-8.
 */
export function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? "";
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const mapped = C_ESCAPES[next];
    if (mapped === undefined) fail(`bad escape "\\${next}" in quoted path ${value}`);
    bytes.push(mapped);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Strips a one-letter diff prefix such as `a/` or `b/`, when present. */
function stripPrefix(value: string): string {
  return /^[a-z]\//.test(value) ? value.slice(2) : value;
}

/** Reads a path from a `---`, `+++`, `rename from` or `copy to` line. */
function headerPath(value: string): string | null {
  const withoutTimestamp = value.startsWith('"') ? value : (value.split("\t")[0] ?? value);
  const unquoted = unquotePath(withoutTimestamp.trimEnd());
  if (unquoted === "/dev/null") return null;
  return stripPrefix(unquoted);
}

/**
 * Splits the paths out of a `diff --git a/x b/y` line. Unquoted paths containing spaces are
 * ambiguous, so the equal-paths reading is tried first; `---`/`+++` and `rename`/`copy`
 * lines override this whenever the header has them.
 */
export function parseGitHeaderPaths(rest: string): { old: string; new: string } | null {
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest);
    if (end === -1) return null;
    const first = unquotePath(rest.slice(0, end + 1));
    const second = rest.slice(end + 2);
    if (second === "") return null;
    return { old: stripPrefix(first), new: stripPrefix(unquotePath(second)) };
  }

  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0) {
    const left = rest.slice(2, 2 + half);
    const right = rest.slice(2 + half + 3);
    if (rest.slice(2 + half, 2 + half + 3) === " b/" && left === right) {
      return { old: left, new: right };
    }
  }

  const split = rest.indexOf(" b/");
  if (split === -1 || !rest.startsWith("a/")) return null;
  return { old: rest.slice(2, split), new: rest.slice(split + 3) };
}

function findQuoteEnd(value: string): number {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === "\\") i += 1;
    else if (value[i] === '"') return i;
  }
  return -1;
}

/**
 * True when this line can only be the start of a new file's block.
 * A bare `---` is not one: that is the separator `git format-patch` puts before its diffstat.
 */
function startsFile(line: string): boolean {
  return line.startsWith("diff --git ") || line.startsWith("--- ");
}

interface FileHeader {
  path: string | null;
  oldPath: string | null;
  status: FileStatus | null;
  renamedFrom: string | null;
  renamedTo: string | null;
  binary: boolean;
}

/** Parses a git-format (or plain) unified diff. Throws StageError on malformed input. */
export function parseDiff(text: string): ParsedFile[] {
  if (text.trim() === "") return [];
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  const lines = normalized.slice(0, -1).split("\n");
  const files: ParsedFile[] = [];

  let i = 0;
  // Preamble (for example git format-patch mail headers and its diffstat) is ignored.
  while (i < lines.length) {
    const line = withoutCr(lines[i] ?? "");
    if (startsFile(line)) break;
    if (HUNK_HEADER.test(line)) fail(`line ${i + 1}: hunk before any file header`);
    i += 1;
  }

  while (i < lines.length) {
    const current = withoutCr(lines[i] ?? "");
    if (current === SIGNATURE) break; // format-patch signature: the diff is over
    if (!startsFile(current)) {
      fail(`line ${i + 1}: unexpected line outside a hunk: ${JSON.stringify(current)}`);
    }
    const start = i;
    const header: FileHeader = {
      path: null,
      oldPath: null,
      status: null,
      renamedFrom: null,
      renamedTo: null,
      binary: false,
    };

    if (current.startsWith("diff --git ")) {
      const paths = parseGitHeaderPaths(current.slice("diff --git ".length));
      if (paths) {
        header.oldPath = paths.old;
        header.path = paths.new;
      }
      i += 1;
    }

    i = readHeaderLines(lines, i, header);
    const { path, oldPath, status } = resolveIdentity(header, i);

    const hunks: Hunk[] = [];
    if (header.binary) {
      // Binary payloads have no line structure; keep them in the raw block and move on.
      while (i < lines.length && !startsFile(withoutCr(lines[i] ?? ""))) i += 1;
    } else {
      while (i < lines.length && withoutCr(lines[i] ?? "").startsWith("@@")) {
        const parsed = parseHunk(lines, i, path, hunks.length + 1);
        hunks.push(parsed.hunk);
        i = parsed.next;
      }
    }

    const raw = lines
      .slice(start, i)
      .map((l) => `${l}\n`)
      .join("");
    const counts = countChanges(hunks);
    files.push({
      path,
      old_path: oldPath,
      status,
      binary: header.binary,
      hunks,
      additions: counts.additions,
      deletions: counts.deletions,
      raw,
      bytes: Buffer.byteLength(raw, "utf8"),
    });
  }

  return files;
}

/** Reads the header lines of one file block, stopping at the first hunk or the next file. */
function readHeaderLines(lines: readonly string[], from: number, header: FileHeader): number {
  let i = from;
  let sawMinus = false;
  while (i < lines.length) {
    const line = withoutCr(lines[i] ?? "");
    if (line.startsWith("@@")) break;
    if (line.startsWith("diff --git ")) break;

    if (line.startsWith("--- ")) {
      if (sawMinus) break; // the next file of a plain unified diff
      sawMinus = true;
      header.oldPath = headerPath(line.slice(4));
      if (header.oldPath === null) header.status ??= "added";
    } else if (line.startsWith("+++ ")) {
      header.path = headerPath(line.slice(4));
      if (header.path === null) header.status ??= "deleted";
    } else if (line.startsWith("new file mode ")) {
      header.status = "added";
    } else if (line.startsWith("deleted file mode ")) {
      header.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      header.renamedFrom = headerPath(line.slice("rename from ".length));
      header.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      header.renamedTo = headerPath(line.slice("rename to ".length));
      header.status = "renamed";
    } else if (line.startsWith("copy from ")) {
      header.renamedFrom = headerPath(line.slice("copy from ".length));
      header.status = "copied";
    } else if (line.startsWith("copy to ")) {
      header.renamedTo = headerPath(line.slice("copy to ".length));
      header.status = "copied";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      header.binary = true;
      i += 1;
      break;
    }
    i += 1;
  }
  return i;
}

/** Turns the collected header lines into the file's path, previous path and status. */
function resolveIdentity(
  header: FileHeader,
  at: number,
): { path: string; oldPath: string | null; status: FileStatus } {
  const status: FileStatus = header.status ?? "modified";
  const newPath = header.renamedTo ?? header.path;
  const oldPath = header.renamedFrom ?? header.oldPath;
  const path = status === "deleted" ? (oldPath ?? newPath) : (newPath ?? oldPath);
  if (path === null || path === "") {
    fail(`line ${at + 1}: file header has no usable path`);
  }
  return {
    path,
    oldPath: status === "renamed" || status === "copied" ? oldPath : null,
    status,
  };
}

function countChanges(hunks: readonly Hunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions += 1;
      else if (line.kind === "del") deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Parses one `@@` hunk, starting at `from`. Returns the hunk and the index after it. */
function parseHunk(
  lines: readonly string[],
  from: number,
  file: string,
  ordinal: number,
): { hunk: Hunk; next: number } {
  const headerLine = withoutCr(lines[from] ?? "");
  const match = HUNK_HEADER.exec(headerLine);
  if (!match) fail(`${file} hunk ${ordinal}: malformed header ${JSON.stringify(headerLine)}`);

  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);

  const body: Line[] = [];
  let oldNo = oldStart;
  let newNo = newStart;
  let oldLeft = oldLines;
  let newLeft = newLines;
  let i = from + 1;

  while (oldLeft > 0 || newLeft > 0) {
    if (i >= lines.length) {
      fail(`${file} hunk ${ordinal}: ended after ${body.length} lines, header promised more`);
    }
    const raw = withoutCr(lines[i] ?? "");
    const marker = raw === "" ? " " : raw[0];
    const text = raw === "" ? "" : raw.slice(1);
    let line: Line;

    if (marker === " ") {
      if (oldLeft === 0 || newLeft === 0) {
        fail(`${file} hunk ${ordinal}: context line past the line counts in the header`);
      }
      line = { kind: "context", old: oldNo, new: newNo, text };
      oldNo += 1;
      newNo += 1;
      oldLeft -= 1;
      newLeft -= 1;
    } else if (marker === "+") {
      if (newLeft === 0) fail(`${file} hunk ${ordinal}: more added lines than the header says`);
      line = { kind: "add", old: null, new: newNo, text };
      newNo += 1;
      newLeft -= 1;
    } else if (marker === "-") {
      if (oldLeft === 0) fail(`${file} hunk ${ordinal}: more deleted lines than the header says`);
      line = { kind: "del", old: oldNo, new: null, text };
      oldNo += 1;
      oldLeft -= 1;
    } else {
      fail(`${file} hunk ${ordinal}: unexpected line ${JSON.stringify(raw)}`);
    }

    i += 1;
    // "\ No newline at end of file" belongs to the line just read and is not counted.
    if (i < lines.length && withoutCr(lines[i] ?? "").startsWith("\\")) {
      line = { ...line, no_newline_at_eof: true };
      i += 1;
    }
    body.push(line);
  }

  if (body.length === 0) fail(`${file} hunk ${ordinal}: has no lines`);

  return {
    hunk: {
      old_start: oldStart,
      old_lines: oldLines,
      new_start: newStart,
      new_lines: newLines,
      section: (match[5] ?? "").trim(),
      lines: body,
    },
    next: i,
  };
}
