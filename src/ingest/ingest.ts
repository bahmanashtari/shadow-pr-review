/**
 * The Ingest stage: parse a diff, decide what the Reviewer sees, and write the three
 * files every later stage reads (ADR-014). Pure apart from {@link writeIngest}, and
 * free of timestamps, so the same input and config always produce the same bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IngestResult, KeptFile, SkippedFile, Source } from "../contracts/generated/ingest.js";
import type { SprConfig } from "../contracts/generated/config.js";
import { checkIngest } from "../contracts/checks.js";
import { assertContract, validateContract } from "../contracts/validate.js";
import { ContractError, StageError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { classify, type SkipReason } from "./filter.js";
import { parseDiff, type ParsedFile } from "./parse-diff.js";
import { riskScore } from "./risk.js";

/** File names written into a run folder by this stage. */
export const INGEST_FILES = {
  raw: "diff.raw.patch",
  kept: "diff.patch",
  json: "ingest.json",
} as const;

/** Input for {@link buildIngest}. */
export interface BuildIngestOptions {
  /** The diff exactly as received. */
  rawDiff: string;
  source: Source;
  config: SprConfig;
}

/** What {@link buildIngest} produces: the contract plus the filtered patch text. */
export interface BuildIngestResult {
  ingest: IngestResult;
  /** The kept files' blocks, concatenated in diff order; written as `diff.patch`. */
  keptPatch: string;
}

interface Candidate {
  file: ParsedFile;
  reason: SkipReason | null;
  risk: number;
}

/**
 * Applies the total diff budget: when the kept files together exceed `maxDiffBytes`,
 * the riskiest files are kept and the rest are skipped as `too_large`.
 * @returns true when at least one file was dropped by the budget.
 */
function applyBudget(candidates: Candidate[], maxDiffBytes: number): boolean {
  const kept = candidates.filter((c) => c.reason === null);
  const total = kept.reduce((sum, c) => sum + c.file.bytes, 0);
  if (total <= maxDiffBytes) return false;

  const ranked = [...kept].sort(
    (a, b) =>
      b.risk - a.risk || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0),
  );
  let used = 0;
  let truncated = false;
  for (const candidate of ranked) {
    if (used + candidate.file.bytes <= maxDiffBytes) {
      used += candidate.file.bytes;
    } else {
      candidate.reason = "too_large";
      truncated = true;
    }
  }
  return truncated;
}

/** Parses and filters a diff into the `ingest.json` contract. Throws on malformed input. */
export function buildIngest(options: BuildIngestOptions): BuildIngestResult {
  const { rawDiff, source, config } = options;
  const candidates: Candidate[] = parseDiff(rawDiff).map((file) => ({
    file,
    reason: classify(file, config.ingest),
    risk: riskScore(file.path),
  }));

  const truncated = applyBudget(candidates, config.ingest.maxDiffBytes);

  const files: KeptFile[] = [];
  const skipped: SkippedFile[] = [];
  const keptBlocks: string[] = [];
  for (const candidate of candidates) {
    const { file, reason, risk } = candidate;
    if (reason !== null) {
      skipped.push({ file: file.path, status: file.status, reason });
      continue;
    }
    files.push({
      path: file.path,
      old_path: file.old_path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      risk_score: risk,
      hunks: file.hunks,
    });
    keptBlocks.push(file.raw);
  }

  const keptPatch = keptBlocks.join("");
  const ingest: IngestResult = {
    schema_version: "1.0",
    source,
    diff: {
      raw_path: INGEST_FILES.raw,
      raw_sha256: sha256(rawDiff),
      raw_bytes: Buffer.byteLength(rawDiff, "utf8"),
      path: INGEST_FILES.kept,
      sha256: sha256(keptPatch),
      bytes: Buffer.byteLength(keptPatch, "utf8"),
      truncated,
    },
    files,
    skipped,
    stats: {
      files_total: candidates.length,
      files_kept: files.length,
      files_skipped: skipped.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    },
  };

  assertContract("ingest", ingest);
  const problems = checkIngest(ingest);
  if (problems.length > 0) throw new ContractError("ingest.json", problems);

  return { ingest, keptPatch };
}

/** Writes `diff.raw.patch`, `diff.patch` and `ingest.json` into a run folder. */
export function writeIngest(runDir: string, rawDiff: string, result: BuildIngestResult): void {
  writeFileSync(path.join(runDir, INGEST_FILES.raw), rawDiff, "utf8");
  writeFileSync(path.join(runDir, INGEST_FILES.kept), result.keptPatch, "utf8");
  writeFileSync(
    path.join(runDir, INGEST_FILES.json),
    `${JSON.stringify(result.ingest, null, 2)}\n`,
    "utf8",
  );
}

/** Reads and validates an existing `ingest.json`, for `spr stage ingest`. */
export function readIngest(runDir: string): IngestResult {
  const file = path.join(runDir, INGEST_FILES.json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new StageError("ingest", `Cannot read ${file}`, { cause });
  }
  const result = validateContract("ingest", parsed);
  if (!result.ok) throw new ContractError(file, result.errors);
  return result.value;
}

/** Reads `diff.raw.patch` from a run folder. */
export function readRawDiff(runDir: string): string {
  const file = path.join(runDir, INGEST_FILES.raw);
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    throw new StageError("ingest", `Cannot read ${file}`, { cause });
  }
}

/** One line such as `3 files: 2 kept (+45 -3), 1 skipped (1 lockfile)`. */
export function summarize(ingest: IngestResult): string {
  const { stats, skipped } = ingest;
  const parts = [
    `${stats.files_total} ${stats.files_total === 1 ? "file" : "files"}:`,
    `${stats.files_kept} kept (+${stats.additions} -${stats.deletions})`,
  ];
  if (skipped.length > 0) {
    const counts = new Map<string, number>();
    for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    const detail = [...counts].map(([reason, n]) => `${n} ${reason}`).join(", ");
    parts.push(`${stats.files_skipped} skipped (${detail})`);
  }
  const line = `${parts[0] ?? ""} ${parts.slice(1).join(", ")}`;
  return ingest.diff.truncated ? `${line}; over the size budget, riskiest files only` : line;
}
