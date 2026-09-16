import { readdirSync, readFileSync } from "node:fs";
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
