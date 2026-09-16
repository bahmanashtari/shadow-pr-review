/**
 * The Verify stage: `review.raw.json` plus `ingest.json` become `review.json`, the only
 * review file the Narrator is allowed to read.
 *
 * ARCHITECTURE.md gives this stage two layers. This is the first: deterministic checks that
 * need no model, so the stage runs offline, instantly, and for free. The Verifier agent
 * (keep / downgrade / drop with a note) joins it in Milestone 3 and judges only what survives
 * here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkReview } from "../contracts/checks.js";
import type { SprConfig } from "../contracts/generated/config.js";
import type { IngestResult } from "../contracts/generated/ingest.js";
import type { DroppedFinding, ReviewResult } from "../contracts/generated/review.js";
import { assertContract, validateContract } from "../contracts/validate.js";
import { HunkIndex } from "../ingest/hunk-index.js";
import { ContractError, StageError } from "../lib/errors.js";
import { REVIEW_RAW_FILE } from "../agents/reviewer.js";
import { screenFindings, type Dropped } from "./grounding.js";

/** File this stage writes. */
export const REVIEW_FILE = "review.json";

/** The schema allows 500 characters of `note`; longer notes are cut, never dropped. */
const MAX_NOTE = 500;

/** Input for {@link runVerify}. */
export interface RunVerifyOptions {
  ingest: IngestResult;
  /** The contents of `review.raw.json`. */
  review: ReviewResult;
  config: SprConfig;
}

/** What the stage produced. */
export interface VerifyOutcome {
  review: ReviewResult;
  kept: number;
  /** The findings this run removed, in id order. Entries already in the raw file are not counted. */
  dropped: DroppedFinding[];
}

/** Turns a rejected finding into the `dropped` entry the contract asks for. */
function toDropped({ finding, rejection }: Dropped): DroppedFinding {
  return {
    id: finding.id,
    file: finding.file,
    line_start: finding.line_start,
    line_end: finding.line_end,
    summary: finding.summary,
    reason: rejection.reason,
    note: rejection.note.slice(0, MAX_NOTE),
  };
}

/**
 * Verifies a raw review against the diff it describes.
 *
 * Ids are carried over unchanged, so `F03` here is `F03` in `review.raw.json` whether it was
 * kept or dropped: `trace.jsonl` and `spr eval` both need that mapping, and gaps in the kept
 * list are informative rather than untidy.
 */
export function runVerify(options: RunVerifyOptions): VerifyOutcome {
  const { ingest, review, config } = options;
  const index = HunkIndex.fromIngest(ingest);

  const screening = screenFindings({
    index,
    findings: review.findings,
    maxFindings: config.review.maxFindings,
  });

  const dropped = screening.dropped.map(toDropped);
  const verified: ReviewResult = {
    ...review,
    findings: screening.kept.map((finding) => ({
      // Surviving the deterministic checks is exactly the claim `verified` makes here: the
      // lines exist and the evidence is verbatim. A verdict already on the finding - from the
      // Milestone 3 agent - is left alone, so re-running the stage never erases one.
      ...finding,
      verification: finding.verification ?? { status: "verified" },
    })),
    // Anything the raw file already dropped stays dropped, which keeps the stage idempotent.
    dropped: [...review.dropped, ...dropped],
  };

  assertContract("review", verified);
  const problems = checkReview(verified, { maxFindings: config.review.maxFindings });
  if (problems.length > 0) throw new ContractError(REVIEW_FILE, problems);

  return { review: verified, kept: verified.findings.length, dropped };
}

/** Reads and validates an existing `review.raw.json`. */
export function readRawReview(runDir: string): ReviewResult {
  const file = path.join(runDir, REVIEW_RAW_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new StageError("verify", `Cannot read ${file}`, { cause });
  }
  const result = validateContract("review", parsed);
  if (!result.ok) throw new ContractError(file, result.errors);
  return result.value;
}

/** Writes `review.json` into a run folder. */
export function writeVerifiedReview(runDir: string, review: ReviewResult): void {
  writeFileSync(path.join(runDir, REVIEW_FILE), `${JSON.stringify(review, null, 2)}\n`, "utf8");
}

/** One line such as `3 findings kept, 2 dropped (1 lines_not_in_diff, 1 duplicate)`. */
export function summarizeVerify(outcome: VerifyOutcome): string {
  const kept = `${outcome.kept} ${outcome.kept === 1 ? "finding" : "findings"} kept`;
  if (outcome.dropped.length === 0) return `${kept}, none dropped`;

  const counts = new Map<string, number>();
  for (const d of outcome.dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  const detail = [...counts].map(([reason, n]) => `${n} ${reason}`).join(", ");
  return `${kept}, ${outcome.dropped.length} dropped (${detail})`;
}
