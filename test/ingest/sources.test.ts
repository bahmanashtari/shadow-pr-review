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
  fromDiffFile,
  fromGitRange,
  parseGitHubRepo,
  parseRange,
} from "../../src/ingest/sources.js";
import { StageError } from "../../src/lib/errors.js";
import { defaultConfig } from "../helpers.js";

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
