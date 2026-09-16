/**
 * Decides which changed files reach the Reviewer.
 * `ingest.ignoreGlobs` in the config is the only thing that removes a file for looking
 * generated or vendored; the categories below only give the skip a readable reason.
 */
import picomatch from "picomatch";
import type { SkippedFile } from "../contracts/generated/ingest.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { ParsedFile } from "./parse-diff.js";

/** Why a file was left out of `diff.patch`. */
export type SkipReason = SkippedFile["reason"];

/** The `ingest` section of the configuration. */
export type IngestConfig = SprConfig["ingest"];

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const VENDOR_SEGMENTS = new Set(["vendor", "third_party", "node_modules"]);
const GENERATED_SEGMENTS = new Set(["generated", "__generated__", "dist", "build", "coverage"]);
const GENERATED_NAMES = [/\.generated\./, /\.gen\.ts$/, /\.min\.js$/, /\.snap$/, /\.pb\.ts$/];

const matchers = new Map<string, picomatch.Matcher>();

/** Compiles (and caches) a matcher for a set of globs. */
function matcherFor(globs: readonly string[]): picomatch.Matcher {
  const key = JSON.stringify(globs);
  let matcher = matchers.get(key);
  if (!matcher) {
    matcher = picomatch([...globs], { dot: true });
    matchers.set(key, matcher);
  }
  return matcher;
}

/** Names the category of an ignored path, so the summary can say "1 lockfile". */
function ignoredReason(path: string): SkipReason {
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;
  if (LOCKFILES.has(name)) return "lockfile";
  if (segments.some((s) => VENDOR_SEGMENTS.has(s))) return "vendored";
  if (segments.some((s) => GENERATED_SEGMENTS.has(s))) return "generated";
  if (GENERATED_NAMES.some((pattern) => pattern.test(name))) return "generated";
  return "ignored_by_config";
}

/**
 * Returns the reason a file is skipped, or null to keep it.
 * The total diff budget (`maxDiffBytes`) is applied later, in `buildIngest`.
 */
export function classify(file: ParsedFile, config: IngestConfig): SkipReason | null {
  if (file.binary) return "binary";
  if (file.bytes > config.maxFileBytes) return "too_large";
  if (matcherFor(config.ignoreGlobs)(file.path)) return ignoredReason(file.path);
  return null;
}
