import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type SprConfig } from "../src/config.js";
import { fromRoot } from "../src/lib/paths.js";
import { assertContract } from "../src/contracts/validate.js";
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
