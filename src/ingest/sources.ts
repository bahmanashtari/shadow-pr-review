/**
 * Where a diff comes from: a file on disk (`--diff`) or a local git range (`--git`).
 * GitHub pull requests (`--pr`) arrive in Milestone 4 and must produce the same fields.
 */
import { readFileSync } from "node:fs";
import type { Source } from "../contracts/generated/ingest.js";
import { StageError } from "../lib/errors.js";
import { run } from "../lib/exec.js";
import { sha256 } from "../lib/hash.js";

/** A diff plus everything ingest needs to describe where it came from. */
export interface DiffSource {
  /** The diff exactly as received. */
  rawDiff: string;
  source: Source;
  /** Short identifier used in the run folder name. */
  id: string;
}

/** Options shared by every source. */
export interface SourceOptions {
  /** Overrides the title shown in the intro. */
  title?: string;
}

/** Options for {@link fromGitRange}. */
export interface GitSourceOptions extends SourceOptions {
  /** Repository to run git in. */
  cwd: string;
}

/**
 * Git settings that make the output independent of the user's configuration:
 * no colour, no external or textconv drivers, and the standard `a/` and `b/` prefixes.
 */
const GIT_DIFF_ARGS: readonly string[] = [
  "-c",
  "core.quotePath=false",
  "-c",
  "color.ui=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.relative=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "--unified=3",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--end-of-options",
];

/** Length of the short id used in run folder names. */
const ID_LENGTH = 7;

/** Reads a unified diff from a file. */
export function fromDiffFile(file: string, options: SourceOptions = {}): DiffSource {
  let rawDiff: string;
  try {
    rawDiff = readFileSync(file, "utf8");
  } catch (cause) {
    throw new StageError("ingest", `Cannot read diff file: ${file}`, { cause });
  }
  return {
    rawDiff,
    source: {
      type: "local_diff",
      repo: null,
      pr_number: null,
      ref: null,
      base_sha: null,
      head_sha: null,
      title: options.title ?? null,
    },
    id: sha256(rawDiff).slice(0, ID_LENGTH),
  };
}

/** Splits `A..B` or `A...B`, rejecting anything that could be read as a git option. */
export function parseRange(range: string): { from: string; to: string; threeDot: boolean } {
  const match = /^(.+?)(\.{2,3})(.+)$/.exec(range);
  if (!match || /\s/.test(range)) {
    throw new StageError("ingest", `Expected a git range such as HEAD~1..HEAD, got "${range}"`);
  }
  const from = match[1] ?? "";
  const to = match[3] ?? "";
  if (from.startsWith("-") || to.startsWith("-")) {
    throw new StageError("ingest", `Revision names must not start with "-": "${range}"`);
  }
  return { from, to, threeDot: match[2] === "..." };
}

/** Resolves a revision to a full commit sha. */
async function revParse(rev: string, cwd: string): Promise<string> {
  const out = await run("git", ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], {
    cwd,
  });
  return out.trim();
}

/** Runs a git command that is allowed to fail (detached HEAD, no remote). */
async function tryGit(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    return (await run("git", args, { cwd })).trim();
  } catch {
    return null;
  }
}

/** `owner/name` when the remote URL points at GitHub, otherwise null. */
export function parseGitHubRepo(remoteUrl: string): string | null {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  if (!match) return null;
  return `${match[1] ?? ""}/${match[2] ?? ""}`;
}

/** Produces a diff for a local commit range, immune to the user's git configuration. */
export async function fromGitRange(range: string, options: GitSourceOptions): Promise<DiffSource> {
  const { cwd } = options;
  const { from, to, threeDot } = parseRange(range);

  const fromSha = await revParse(from, cwd);
  const headSha = await revParse(to, cwd);
  const baseSha = threeDot
    ? (await run("git", ["merge-base", "--end-of-options", fromSha, headSha], { cwd })).trim()
    : fromSha;

  const rawDiff = await run("git", [...GIT_DIFF_ARGS, range], { cwd, timeoutMs: 120_000 });

  const currentHead = await tryGit(
    ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
    cwd,
  );
  const branch =
    currentHead === headSha ? await tryGit(["symbolic-ref", "--short", "-q", "HEAD"], cwd) : null;
  const remote = await tryGit(["remote", "get-url", "origin"], cwd);
  const subject = await tryGit(["log", "-1", "--format=%s", "--end-of-options", headSha], cwd);

  return {
    rawDiff,
    source: {
      type: "push",
      repo: remote === null ? null : parseGitHubRepo(remote),
      pr_number: null,
      ref: branch === null || branch === "" ? null : branch,
      base_sha: baseSha,
      head_sha: headSha,
      title: options.title ?? subject ?? null,
    },
    id: headSha.slice(0, ID_LENGTH),
  };
}
