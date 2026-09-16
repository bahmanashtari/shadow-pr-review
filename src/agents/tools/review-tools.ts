/**
 * The Reviewer's read-only tools (CLAUDE.md: no shell, no writes, no network).
 *
 * `list_changed_files` and `get_diff_hunk` need only `ingest.json`, so they work for every
 * source. `read_file` and `grep_repo` need a checkout; without one they are not registered
 * at all, and the prompt says so, rather than being offered and always failing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { IngestResult } from "../../contracts/generated/ingest.js";
import { ToolRegistry, type ToolHandler } from "../../harness/tools.js";
import { run } from "../../lib/exec.js";
import { renderFileDiff } from "../diff-view.js";

/** Most lines `read_file` will return in one call. */
const MAX_FILE_LINES = 200;
/** Most matches `grep_repo` will return. */
const MAX_GREP_MATCHES = 40;

/** Options for {@link buildReviewTools}. */
export interface ReviewToolsOptions {
  ingest: IngestResult;
  /** Absolute path of the checkout, when there is one. */
  repoRoot?: string;
}

/**
 * Resolves a repo-relative path and refuses anything that escapes the checkout.
 * @throws Error when the path leaves the repository.
 */
export function resolveInsideRepo(repoRoot: string, candidate: string): string {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the repository: ${candidate}`);
  }
  return resolved;
}

function listChangedFiles(ingest: IngestResult): ToolHandler {
  return {
    definition: {
      name: "list_changed_files",
      description:
        "Lists every file in this change with its status, risk score and line counts. " +
        "Use it to decide which file to look at next.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    run: () => {
      const lines = ingest.files.map(
        (f) => `${f.path} (${f.status}) risk ${f.risk_score} +${f.additions} -${f.deletions}`,
      );
      const skipped = ingest.skipped.map((s) => `${s.file} (not reviewed: ${s.reason})`);
      return [...lines, ...skipped].join("\n") || "No files in this change.";
    },
  };
}

function getDiffHunk(ingest: IngestResult): ToolHandler {
  return {
    definition: {
      name: "get_diff_hunk",
      description:
        "Shows one file's changed lines again, with line numbers, exactly as in the diff.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
        properties: {
          file: { type: "string", description: "Repo-relative path as shown in the diff." },
        },
      },
    },
    run: (input) => {
      const wanted = typeof input.file === "string" ? input.file : "";
      const file = ingest.files.find((f) => f.path === wanted);
      if (!file) {
        const known = ingest.files.map((f) => f.path).join(", ");
        return `No file "${wanted}" in this change. Files: ${known}`;
      }
      return renderFileDiff(file);
    },
  };
}

function readFile(repoRoot: string): ToolHandler {
  return {
    definition: {
      name: "read_file",
      description:
        "Reads lines from a file at the current revision, to see code the diff does not show. " +
        `Returns at most ${MAX_FILE_LINES} lines.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "start", "end"],
        properties: {
          path: { type: "string", description: "Repo-relative path." },
          start: { type: "integer", minimum: 1 },
          end: { type: "integer", minimum: 1 },
        },
      },
    },
    run: (input) => {
      const file = resolveInsideRepo(repoRoot, typeof input.path === "string" ? input.path : "");
      const start = Number(input.start);
      const end = Math.min(Number(input.end), start + MAX_FILE_LINES - 1);
      if (end < start) return `end (${end}) is before start (${start}).`;

      const lines = readFileSync(file, "utf8").split("\n");
      if (start > lines.length) return `That file has only ${lines.length} lines.`;
      return lines
        .slice(start - 1, end)
        .map((text, i) => `${String(start + i).padStart(4)} ${text}`)
        .join("\n");
    },
  };
}

function grepRepo(repoRoot: string): ToolHandler {
  return {
    definition: {
      name: "grep_repo",
      description:
        "Searches the repository for a fixed string, to check whether something already " +
        `exists (a repository port, an outbox table). Returns at most ${MAX_GREP_MATCHES} matches.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pattern"],
        properties: {
          pattern: { type: "string", minLength: 2, description: "Literal text to look for." },
          glob: { type: "string", description: "Optional path filter, for example '*.ts'." },
        },
      },
    },
    run: async (input) => {
      // The schema guarantees these types; narrow anyway rather than stringify an object.
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const glob = typeof input.glob === "string" ? input.glob : null;
      if (pattern === "") return "pattern must be a string.";
      // Fixed argument list, no shell: the pattern is data, never part of a command line.
      const args = [
        "grep",
        "--no-color",
        "-n",
        "--fixed-strings",
        `--max-count=${MAX_GREP_MATCHES}`,
        "-e",
        pattern,
      ];
      if (glob !== null) args.push("--", glob);

      try {
        const out = await run("git", args, { cwd: repoRoot, timeoutMs: 20_000 });
        const matches = out.trim().split("\n").filter(Boolean).slice(0, MAX_GREP_MATCHES);
        return matches.length === 0 ? `No matches for "${pattern}".` : matches.join("\n");
      } catch {
        // git grep exits non-zero when nothing matched, which is not an error here.
        return `No matches for "${pattern}".`;
      }
    },
  };
}

/** Builds the registry for one review, offering only the tools that can actually work. */
export function buildReviewTools(options: ReviewToolsOptions): ToolRegistry {
  const handlers: ToolHandler[] = [listChangedFiles(options.ingest), getDiffHunk(options.ingest)];
  if (options.repoRoot !== undefined) {
    handlers.push(readFile(options.repoRoot), grepRepo(options.repoRoot));
  }
  return new ToolRegistry(handlers);
}
