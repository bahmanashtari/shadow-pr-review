/**
 * Exercises the `--git` source against a real repository, with a deliberately hostile
 * global git configuration, to prove the diff a developer gets does not depend on theirs.
 */
import { execa } from "execa";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIngest } from "../../src/ingest/ingest.js";
import {
  checkoutAt,
  fromDiffFile,
  fromGitRange,
  fromPullRequest,
  originRepo,
  parseGitHubRepo,
  parseRange,
} from "../../src/ingest/sources.js";
import { StageError } from "../../src/lib/errors.js";
import { GitHubError, parsePullRequest, type GitHubClient } from "../../src/lib/github.js";
import {
  defaultConfig,
  PR_BASE_SHA,
  PR_HEAD_SHA,
  pullRequestJson,
  readGoldenDiff,
} from "../helpers.js";

const HOSTILE_GIT_CONFIG = [
  "[user]",
  "  name = Test Person",
  "  email = test@example.com",
  "[diff]",
  "  noprefix = true",
  "  external = false",
  "  mnemonicPrefix = true",
  "[color]",
  "  ui = always",
  "[commit]",
  "  gpgsign = false",
  "",
].join("\n");

let repo: string;
let home: string;
let previousGlobal: string | undefined;
let previousSystem: string | undefined;
let baseSha: string;
let headSha: string;
let featureSha: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: repo });
  return stdout.trim();
}

function write(file: string, content: string | Uint8Array): void {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "spr-githome-"));
  const configFile = path.join(home, "gitconfig");
  writeFileSync(configFile, HOSTILE_GIT_CONFIG, "utf8");
  previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  previousSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = configFile;
  process.env.GIT_CONFIG_SYSTEM = path.join(home, "missing-system-config");

  repo = mkdtempSync(path.join(tmpdir(), "spr-repo-"));
  await git("init", "-b", "main");
  await git("remote", "add", "origin", "git@github.com:acme/shop-platform.git");

  write("src/app.ts", "export const version = 1;\n");
  write("src/old-name.ts", "export function greet(name: string): string {\n  return name;\n}\n");
  write("src/legacy.ts", "export function legacy(): void {}\n");
  await git("add", "-A");
  await git("commit", "-m", "Base commit");
  baseSha = await git("rev-parse", "HEAD");

  write("src/app.ts", "export const version = 2;\n");
  await git("mv", "src/old-name.ts", "src/new-name.ts");
  await git("rm", "-q", "src/legacy.ts");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]));
  write("src/domain/order.ts", "export class Order {}\n");
  await git("add", "-A");
  await git("commit", "-m", "Add the order aggregate and rename the greeter");
  headSha = await git("rev-parse", "HEAD");

  await git("checkout", "-q", "-b", "feature", headSha);
  write("src/domain/order.ts", "export class Order {\n  readonly id = '1';\n}\n");
  await git("add", "-A");
  await git("commit", "-m", "Give the order an id");
  featureSha = await git("rev-parse", "HEAD");
});

afterAll(() => {
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
  if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = previousSystem;
  for (const dir of [repo, home]) rmSync(dir, { recursive: true, force: true });
});

describe("fromGitRange", () => {
  it("describes a two-dot range and ignores the user's git configuration", async () => {
    const source = await fromGitRange(`${baseSha}..${headSha}`, { cwd: repo });

    expect(source.source).toEqual({
      type: "push",
      repo: "acme/shop-platform",
      pr_number: null,
      ref: null, // HEAD is on `feature`, not on the commit at the end of the range
      base_sha: baseSha,
      head_sha: headSha,
      title: "Add the order aggregate and rename the greeter",
    });
    expect(source.id).toBe(headSha.slice(0, 7));
    // `diff.noprefix`, `diff.mnemonicPrefix` and `color.ui` in the global config lose.
    expect(source.rawDiff).toContain("--- a/src/app.ts");
    expect(source.rawDiff).toContain("+++ b/src/app.ts");
    expect(source.rawDiff).not.toContain(`${String.fromCharCode(27)}[`);
  });

  it("classifies every kind of change in that range", async () => {
    const { rawDiff, source } = await fromGitRange(`${baseSha}..${headSha}`, { cwd: repo });
    const { ingest } = buildIngest({ rawDiff, source, config: defaultConfig() });

    expect(ingest.files.map((f) => [f.path, f.status, f.old_path])).toEqual([
      ["src/app.ts", "modified", null],
      ["src/domain/order.ts", "added", null],
      ["src/legacy.ts", "deleted", null],
      ["src/new-name.ts", "renamed", "src/old-name.ts"],
    ]);
    expect(ingest.skipped).toEqual([
      { file: "assets/logo.png", status: "added", reason: "binary" },
      { file: "pnpm-lock.yaml", status: "added", reason: "lockfile" },
    ]);
  });

  it("uses the merge base for a three-dot range and reports the branch", async () => {
    const source = await fromGitRange("main...feature", { cwd: repo });
    expect(source.source.base_sha).toBe(headSha); // main is the merge base of main and feature
    expect(source.source.head_sha).toBe(featureSha);
    expect(source.source.ref).toBe("feature");
    expect(source.rawDiff).toContain("src/domain/order.ts");
  });

  it("takes the title from the option when given", async () => {
    const source = await fromGitRange(`${baseSha}..${headSha}`, { cwd: repo, title: "Custom" });
    expect(source.source.title).toBe("Custom");
  });

  it("refuses ranges that could be read as git options", async () => {
    await expect(fromGitRange("--output=x..y", { cwd: repo })).rejects.toThrow(StageError);
    await expect(fromGitRange("--output=x..y", { cwd: repo })).rejects.toThrow(
      'must not start with "-"',
    );
    await expect(fromGitRange("HEAD~1 HEAD", { cwd: repo })).rejects.toThrow(
      "Expected a git range",
    );
    await expect(fromGitRange("HEAD", { cwd: repo })).rejects.toThrow("Expected a git range");
  });

  it("reports an unknown revision as a failed command", async () => {
    await expect(fromGitRange("nope..HEAD", { cwd: repo })).rejects.toThrow(/git rev-parse/);
  });
});

describe("parseRange", () => {
  it.each([
    ["HEAD~1..HEAD", { from: "HEAD~1", to: "HEAD", threeDot: false }],
    ["main...feature", { from: "main", to: "feature", threeDot: true }],
    ["v1.0.0..v1.1.0", { from: "v1.0.0", to: "v1.1.0", threeDot: false }],
  ])("%s", (range, expected) => {
    expect(parseRange(range)).toEqual(expected);
  });
});

describe("parseGitHubRepo", () => {
  it.each([
    ["git@github.com:acme/shop.git", "acme/shop"],
    ["https://github.com/acme/shop.git", "acme/shop"],
    ["https://github.com/acme/shop", "acme/shop"],
    ["ssh://git@github.com/acme/shop.git", "acme/shop"],
    ["https://gitlab.com/acme/shop.git", null],
  ])("%s -> %s", (url, expected) => {
    expect(parseGitHubRepo(url)).toBe(expected);
  });
});

describe("fromDiffFile", () => {
  it("reads a diff file and identifies the run by its hash", () => {
    const file = path.join(repo, "change.patch");
    writeFileSync(file, "diff --git a/x.ts b/x.ts\n", "utf8");
    const source = fromDiffFile(file, { title: "A local diff" });
    expect(source.source).toEqual({
      type: "local_diff",
      repo: null,
      pr_number: null,
      ref: null,
      base_sha: null,
      head_sha: null,
      title: "A local diff",
    });
    expect(source.id).toMatch(/^[a-f0-9]{7}$/);
  });

  it("fails clearly when the file is missing", () => {
    expect(() => fromDiffFile(path.join(repo, "missing.patch"))).toThrow(StageError);
  });
});

/** A client that answers with a pull request and a diff, or fails the way it is told to. */
function fakeGitHub(diff: string | GitHubError, pr: unknown = pullRequestJson()): GitHubClient {
  return {
    getPullRequest: () => Promise.resolve(parsePullRequest(pr)),
    getPullRequestDiff: () =>
      typeof diff === "string" ? Promise.resolve(diff) : Promise.reject(diff),
  };
}

describe("fromPullRequest", () => {
  it("gives the same ingest as the same diff from a file, apart from the source", async () => {
    const diff = readGoldenDiff("sample-01-order-outbox");
    const source = await fromPullRequest(142, "acme/shop", { github: fakeGitHub(diff) });

    expect(source.source).toEqual({
      type: "pull_request",
      repo: "acme/shop",
      pr_number: 142,
      ref: "feature/outbox",
      base_sha: PR_BASE_SHA,
      head_sha: PR_HEAD_SHA,
      title: "Publish OrderPlaced through the outbox",
    });
    expect(source.id).toBe(`pr142-${PR_HEAD_SHA.slice(0, 7)}`);
    expect(source.rawDiff).toBe(diff);

    const file = path.join(repo, "pr.patch");
    writeFileSync(file, diff, "utf8");
    const local = fromDiffFile(file);
    const config = defaultConfig();
    const fromPr = buildIngest({ rawDiff: source.rawDiff, source: source.source, config });
    const fromFile = buildIngest({ rawDiff: local.rawDiff, source: local.source, config });
    expect({ ...fromPr.ingest, source: null }).toEqual({ ...fromFile.ingest, source: null });
    expect(fromPr.keptPatch).toBe(fromFile.keptPatch);
  });

  it("takes the title from the option when given", async () => {
    const source = await fromPullRequest(142, "acme/shop", {
      github: fakeGitHub(""),
      title: "Mine",
    });
    expect(source.source.title).toBe("Mine");
  });

  it("fails as an ingest error with GitHub's line", async () => {
    const github: GitHubClient = {
      getPullRequest: () =>
        Promise.reject(new GitHubError("Pull request acme/shop#7 was not found.", 404)),
      getPullRequestDiff: () => Promise.reject(new Error("not reached")),
    };
    const error = await fromPullRequest(7, "acme/shop", { github }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageError);
    expect((error as StageError).stage).toBe("ingest");
    expect((error as StageError).message).toBe("Pull request acme/shop#7 was not found.");
  });

  it("says how to review a diff GitHub will not render, with the exact range", async () => {
    const tooLarge = new GitHubError("GitHub will not render the diff (406).", 406, true);
    const error = await fromPullRequest(142, "acme/shop", { github: fakeGitHub(tooLarge) }).catch(
      (e: unknown) => e,
    );
    expect((error as StageError).message).toBe(
      "GitHub will not render the diff (406). Review it from a checkout instead: " +
        `git fetch origin pull/142/head, then spr run --git ${PR_BASE_SHA}...${PR_HEAD_SHA}`,
    );
  });
});

describe("originRepo", () => {
  it("reads owner/name from the origin remote", async () => {
    expect(await originRepo(repo)).toBe("acme/shop-platform");
  });

  it("is null outside a repository", async () => {
    expect(await originRepo(home)).toBeNull();
  });
});

describe("checkoutAt", () => {
  it("is the repository root when HEAD is the head sha, from any folder inside it", async () => {
    const head = await git("rev-parse", "HEAD");
    const root = await git("rev-parse", "--show-toplevel");
    expect(await checkoutAt(head, repo)).toBe(root);
    expect(await checkoutAt(head, path.join(repo, "src"))).toBe(root);
  });

  it("is undefined when HEAD is some other commit", async () => {
    expect(await checkoutAt(baseSha, repo)).toBeUndefined();
  });

  it("is undefined outside a repository, and without a head sha", async () => {
    expect(await checkoutAt(baseSha, home)).toBeUndefined();
    expect(await checkoutAt(null, repo)).toBeUndefined();
  });
});
