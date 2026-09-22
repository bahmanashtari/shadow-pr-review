/**
 * Where a diff comes from: a file on disk (`--diff`), a local git range (`--git`) or a GitHub
 * pull request (`--pr`). All three produce the same fields, so nothing after ingest can tell
 * them apart except by `source.type`.
 */
import { readFileSync } from "node:fs";
import type { Source } from "../contracts/generated/ingest.js";
import { StageError } from "../lib/errors.js";
import { run } from "../lib/exec.js";
import { GitHubError, type GitHubClient } from "../lib/github.js";
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
  /** Overrides the title the source would give the change (commit subject, PR title). */
  title?: string;
}

/** Options for {@link fromGitRange}. */
export interface GitSourceOptions extends SourceOptions {
  /** Repository to run git in. */
  cwd: string;
}

/** Options for {@link fromPullRequest}. */
export interface PullRequestSourceOptions extends SourceOptions {
  /** Only the reading half: ingest never writes to GitHub. */
  github: Pick<GitHubClient, "getPullRequest" | "getPullRequestDiff">;
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

/** The GitHub repository of the `origin` remote in `cwd`, or null when there is none. */
export async function originRepo(cwd: string): Promise<string | null> {
  const remote = await tryGit(["remote", "get-url", "origin"], cwd);
  return remote === null ? null : parseGitHubRepo(remote);
}

/**
 * Reads a pull request and its diff from GitHub. The diff is GitHub's own, base...head from the
 * merge base, which is what `--git base...head` gives on a checkout - so an oversized diff that
 * GitHub will not render can still be reviewed that way, and the error says how.
 *
 * Two requests, one after the other: a push between them would pair the new diff with the old
 * head sha. In CI a newer push cancels this run anyway (`concurrency`), so the window is not
 * closed with a third request.
 * @throws StageError with GitHub's failure in one line.
 */
export async function fromPullRequest(
  number: number,
  repo: string,
  options: PullRequestSourceOptions,
): Promise<DiffSource> {
  const { github } = options;
  const pr = await github.getPullRequest(repo, number).catch((cause: unknown) => {
    throw asStageError(cause);
  });
  const rawDiff = await github.getPullRequestDiff(repo, number).catch((cause: unknown) => {
    const tooLarge = cause instanceof GitHubError && cause.tooLarge;
    throw asStageError(
      cause,
      tooLarge
        ? ` Review it from a checkout instead: git fetch origin pull/${number}/head, then` +
            ` spr run --git ${pr.baseSha}...${pr.headSha}`
        : "",
    );
  });

  return {
    rawDiff,
    source: {
      type: "pull_request",
      repo,
      pr_number: number,
      ref: pr.headRef,
      base_sha: pr.baseSha,
      head_sha: pr.headSha,
      title: options.title ?? pr.title,
    },
    id: `pr${number}-${pr.headSha.slice(0, ID_LENGTH)}`,
  };
}

/** Wraps a GitHub failure for the CLI, which prints a StageError on one line. */
function asStageError(cause: unknown, advice = ""): StageError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new StageError("ingest", `${message}${advice}`, { cause });
}

/**
 * The root of the checkout in `cwd` when its `HEAD` is exactly `headSha`, otherwise undefined.
 *
 * `read_file` reads the working tree and `grep_repo` searches it, so both describe the reviewed
 * change only when the tree is at that change's head. Anywhere else - another branch, the test
 * merge commit `actions/checkout` makes for a `pull_request` event, a folder that is not a
 * repository - they would answer about different code, and the Reviewer would cite it. So the
 * tools are offered only on this exact match (ADR-051). Uncommitted edits are not detected:
 * a developer's working tree is theirs to keep clean.
 */
export async function checkoutAt(headSha: string | null, cwd: string): Promise<string | undefined> {
  if (headSha === null) return undefined;
  const head = await tryGit(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], cwd);
  if (head !== headSha) return undefined;
  return (await tryGit(["rev-parse", "--show-toplevel"], cwd)) ?? undefined;
}
