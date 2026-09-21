import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type SprConfig } from "../src/config.js";
import { fromRoot } from "../src/lib/paths.js";
import { assertContract } from "../src/contracts/validate.js";
import type { IngestResult, Source } from "../src/contracts/generated/ingest.js";
import { buildIngest } from "../src/ingest/ingest.js";
import type { ReviewResult } from "../src/contracts/generated/review.js";
import type { NarrationScript } from "../src/contracts/generated/script.js";

export const GOLDEN_DIR = fromRoot("golden");

/** Names of all golden samples, for example `sample-01-order-outbox`. */
export const GOLDEN_SAMPLES: string[] = readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("sample-"))
  .map((d) => d.name)
  .sort();

/** Reads and parses a JSON file from a golden sample. */
export function readGoldenJson(sample: string, file: string): unknown {
  return JSON.parse(readFileSync(fromRoot("golden", sample, file), "utf8"));
}

/** A fresh, validated copy of a sample's expected review and script (safe to mutate). */
export function loadGolden(sample: string): { review: ReviewResult; script: NarrationScript } {
  return {
    review: assertContract("review", readGoldenJson(sample, "review.expected.json")),
    script: assertContract("script", readGoldenJson(sample, "script.expected.json")),
  };
}

/** Folder holding the hand-written diff fixtures used by the parser tests. */
export const DIFF_FIXTURES = fromRoot("test", "fixtures", "diffs");

/** Reads one fixture diff, for example `no-newline.patch` or `bad/stray-line.patch`. */
export function readDiffFixture(name: string): string {
  return readFileSync(path.join(DIFF_FIXTURES, name), "utf8");
}

/** Names of the well-formed fixture diffs. */
export function diffFixtureNames(): string[] {
  return readdirSync(DIFF_FIXTURES)
    .filter((name) => name.endsWith(".patch"))
    .sort();
}

/** The shipped defaults, free of any SPR_* variables the developer happens to have set. */
export function defaultConfig(): SprConfig {
  return loadConfig({ env: {} });
}

/** The shipped defaults with the `ingest` section adjusted. */
export function configWithIngest(overrides: Partial<SprConfig["ingest"]>): SprConfig {
  const config = defaultConfig();
  return { ...config, ingest: { ...config.ingest, ...overrides } };
}

/** Reads a golden sample's diff. */
export function readGoldenDiff(sample: string): string {
  return readFileSync(fromRoot("golden", sample, "diff.patch"), "utf8");
}

/** A `local_diff` source, for tests that build an ingest by hand. */
export const TEST_SOURCE: Source = {
  type: "local_diff",
  repo: null,
  pr_number: null,
  ref: null,
  base_sha: null,
  head_sha: null,
  title: null,
};

/** Ingests raw diff text with the shipped defaults. */
export function ingestOfDiff(rawDiff: string): IngestResult {
  return buildIngest({ rawDiff, source: { ...TEST_SOURCE }, config: defaultConfig() }).ingest;
}

/** The head sha of the pull request {@link pullRequestJson} describes. */
export const PR_HEAD_SHA = "a".repeat(40);
/** Its base sha. */
export const PR_BASE_SHA = "b".repeat(40);

/**
 * GitHub's JSON for pull request acme/shop#142: the fields the client reads, plus a few it
 * ignores, as the real response carries many more.
 */
export function pullRequestJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://api.github.com/repos/acme/shop/pulls/142",
    number: 142,
    state: "open",
    title: "Publish OrderPlaced through the outbox",
    draft: false,
    user: { login: "someone" },
    head: { ref: "feature/outbox", sha: PR_HEAD_SHA, repo: { full_name: "acme/shop" } },
    base: { ref: "main", sha: PR_BASE_SHA, repo: { full_name: "acme/shop" } },
    ...over,
  };
}
