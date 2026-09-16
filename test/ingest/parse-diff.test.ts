import { describe, expect, it } from "vitest";
import {
  parseDiff,
  parseGitHeaderPaths,
  unquotePath,
  type ParsedFile,
} from "../../src/ingest/parse-diff.js";
import type { Hunk } from "../../src/contracts/generated/ingest.js";
import { StageError } from "../../src/lib/errors.js";
import { diffFixtureNames, readDiffFixture } from "../helpers.js";

function only(name: string): ParsedFile {
  const files = parseDiff(readDiffFixture(name));
  const file = files[0];
  if (!file) throw new Error(`${name} parsed to no files`);
  return file;
}

function firstHunk(file: ParsedFile): Hunk {
  const hunk = file.hunks[0];
  if (!hunk) throw new Error(`${file.path} has no hunks`);
  return hunk;
}

describe("parseDiff", () => {
  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("\n \n")).toEqual([]);
  });

  it("reads a rename with edits", () => {
    const file = only("rename-with-edits.patch");
    expect(file).toMatchObject({
      path: "src/new-name.ts",
      old_path: "src/old-name.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      binary: false,
    });
    expect(firstHunk(file).section).toBe("export function greet");
  });

  it("reads a pure rename and a mode change as files without hunks", () => {
    expect(only("pure-rename.patch")).toMatchObject({
      path: "docs/new.md",
      old_path: "docs/old.md",
      status: "renamed",
      hunks: [],
    });
    const modes = parseDiff(readDiffFixture("mode-only.patch"));
    expect(modes.map((f) => [f.path, f.status, f.hunks.length, f.old_path])).toEqual([
      ["scripts/deploy.sh", "modified", 0, null],
      // Unquoted spaces are only resolvable because both sides are the same path.
      ["scripts/my script.sh", "modified", 0, null],
    ]);
  });

  it("reads a copy", () => {
    expect(only("copy.patch")).toMatchObject({
      path: "src/copy-of-template.ts",
      old_path: "src/template.ts",
      status: "copied",
    });
  });

  it("reads a deletion, using the old path and numbering only the old side", () => {
    const file = only("deleted.patch");
    expect(file).toMatchObject({ path: "src/legacy.ts", old_path: null, status: "deleted" });
    const hunk = firstHunk(file);
    expect([hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines]).toEqual([1, 3, 0, 0]);
    expect(hunk.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["del", 1, null],
      ["del", 2, null],
      ["del", 3, null],
    ]);
  });

  it("marks binary files and keeps parsing the files after them", () => {
    const files = parseDiff(readDiffFixture("binary.patch"));
    expect(files.map((f) => [f.path, f.status, f.binary, f.hunks.length])).toEqual([
      ["assets/logo.png", "added", true, 0],
      ["assets/icon.bin", "modified", true, 0],
      ["src/app.ts", "modified", false, 1],
    ]);
    // `@@ -1 +1 @@`: a missing count means one line.
    const hunk = firstHunk(files[2] as ParsedFile);
    expect([hunk.old_lines, hunk.new_lines]).toEqual([1, 1]);
  });

  it("marks the last line of each side when the file has no trailing newline", () => {
    const hunk = firstHunk(only("no-newline.patch"));
    expect(hunk.lines.map((l) => [l.kind, l.no_newline_at_eof ?? false])).toEqual([
      ["context", false],
      ["del", true],
      ["add", true],
    ]);
  });

  it("decodes quoted paths", () => {
    const files = parseDiff(readDiffFixture("quoted-paths.patch"));
    expect(files.map((f) => f.path)).toEqual(["src/file with space.ts", 'src/café "quoted".ts']);
  });

  it("numbers several hunks of one file from their own headers", () => {
    const file = only("multi-hunk.patch");
    expect(file.hunks.map((h) => [h.old_start, h.old_lines, h.new_start, h.new_lines])).toEqual([
      [1, 4, 1, 5],
      [20, 7, 21, 7],
    ]);
    expect(file.hunks[1]?.section).toBe("export class Service {");
    const added = file.hunks[0]?.lines.find((l) => l.kind === "add");
    expect(added).toEqual({
      kind: "add",
      old: null,
      new: 2,
      text: "import { Logger } from '@nestjs/common';",
    });
    // The empty context line keeps its numbers on both sides.
    expect(file.hunks[0]?.lines[2]).toEqual({ kind: "context", old: 2, new: 3, text: "" });
  });

  it("strips the carriage return from CRLF diffs", () => {
    const file = only("crlf.patch");
    expect(file.hunks[0]?.lines.map((l) => l.text)).toEqual([
      "const a = 1;",
      "const b = 2;",
      "const b = 3;",
      "const c = 4;",
    ]);
  });

  it("accepts plain unified diffs and drops the timestamps", () => {
    const files = parseDiff(readDiffFixture("plain-unified.patch"));
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/plain.ts", "modified"],
      ["src/other.ts", "modified"],
    ]);
  });

  it("ignores a format-patch preamble, diffstat separator and signature", () => {
    const files = parseDiff(readDiffFixture("format-patch.patch"));
    expect(files.map((f) => [f.path, f.additions])).toEqual([["src/flags.ts", 2]]);
    expect(files[0]?.raw.startsWith("diff --git")).toBe(true);
    expect(files[0]?.raw).not.toContain("2.50.1");
  });

  it.each(diffFixtureNames().filter((n) => n !== "format-patch.patch"))(
    "%s rebuilds byte for byte from the file blocks",
    (name) => {
      const text = readDiffFixture(name);
      expect(
        parseDiff(text)
          .map((f) => f.raw)
          .join(""),
      ).toBe(text);
    },
  );

  it.each([
    ["bad/wrong-counts.patch", "header promised more"],
    ["bad/stray-line.patch", "unexpected line outside a hunk"],
    ["bad/hunk-before-header.patch", "hunk before any file header"],
    ["bad/unknown-prefix.patch", "unexpected line"],
  ])("%s is rejected", (name, message) => {
    expect(() => parseDiff(readDiffFixture(name))).toThrow(StageError);
    expect(() => parseDiff(readDiffFixture(name))).toThrow(message);
  });
});

describe("unquotePath", () => {
  it.each([
    ['"a/plain.ts"', "a/plain.ts"],
    ['"a/with space.ts"', "a/with space.ts"],
    ['"a/say \\"hi\\".ts"', 'a/say "hi".ts'],
    ['"a/caf\\303\\251.ts"', "a/café.ts"],
    ['"a/tab\\there.ts"', "a/tab\there.ts"],
    ['"a/back\\\\slash.ts"', "a/back\\slash.ts"],
    ["a/unquoted.ts", "a/unquoted.ts"],
  ])("%s -> %s", (input, expected) => {
    expect(unquotePath(input)).toBe(expected);
  });
});

describe("parseGitHeaderPaths", () => {
  it.each([
    ["a/src/x.ts b/src/x.ts", { old: "src/x.ts", new: "src/x.ts" }],
    ["a/old.ts b/new.ts", { old: "old.ts", new: "new.ts" }],
    ["a/my file.ts b/my file.ts", { old: "my file.ts", new: "my file.ts" }],
    ['"a/caf\\303\\251.ts" "b/caf\\303\\251.ts"', { old: "café.ts", new: "café.ts" }],
  ])("%s", (rest, expected) => {
    expect(parseGitHeaderPaths(rest)).toEqual(expected);
  });

  it("gives up on input that is not a git header", () => {
    expect(parseGitHeaderPaths("nonsense")).toBeNull();
  });
});
